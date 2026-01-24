import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import { v4 as uuidv4 } from 'uuid';
import { logger, S3Event } from './config';
import { runTranscribeWorkflow } from './jobs/transcribe';
import { runRekognitionWorkflow } from './jobs/rekognition';
import { buildCorpus, mapResultsToSources } from './analysis/corpus';
import { analyzeToxicity } from './analysis/toxicity';
import { analyzeSentiment } from './analysis/sentiment';
import { detectPII } from './analysis/pii';
import { generateAISummary } from './reporting/ai-summary';
import { saveReportsToS3 } from './storage/s3';
import { saveScanMetadata, waitForApproval, updateApprovalStatus } from './storage/dynamodb';
import { publishEvent } from './events/appsync';


export const handler = withDurableExecution(async (event: S3Event, context) => {
  const bucketName = event.detail.bucket.name;
  const objectKey = event.detail.object.key;
  const objectSize = event.detail.object.size;

  // Extract userId from objectKey (format: raw/{userId}/{filename})
  const keyParts = objectKey.split('/');
  const userId = keyParts.length >= 2 ? keyParts[1] : 'unknown';

  // STEP: Generate unique scan ID and timestamp
  // Uses context.step() to ensure deterministic replay - same scanId on retries
  const { scanId, uploadedAt } = await context.step('generate-scan-id', async () => ({
    scanId: uuidv4(),
    uploadedAt: new Date().toISOString(),
  }));

  try {
    // STEP: Publish scan started event to AppSync
    await context.step('publish-scan-started', async () => {
      await publishEvent({
        type: 'SCAN_STARTED',
        scanId,
        userId,
        timestamp: new Date().toISOString(),
        data: { objectKey, objectSize },
      });
    });

    // STEP: Run Transcribe and Rekognition jobs in parallel
    // Demonstrates context.parallel() with child contexts
    // Each branch uses waitForCallback() to handle async AWS service jobs
    const parallelResults = await context.parallel([
      // Branch 1: Transcription workflow (audio analysis)
      async (childContext) => {
        return await runTranscribeWorkflow(childContext, bucketName, objectKey, scanId);
      },

      // Branch 2: Rekognition workflow (video text detection)
      async (childContext) => {
        return await runRekognitionWorkflow(childContext, bucketName, objectKey, scanId);
      }
    ]);

    // Extract results from parallel execution with error handling
    const transcriptData = parallelResults.all[0]?.result as import('./config').TranscriptData | undefined;
    const rekognitionData = parallelResults.all[1]?.result as { videoTextData: import('./config').VideoTextData | null; error: string | null } | undefined;
    
    if (!transcriptData) {
      throw new Error('Transcription failed - no transcript data returned');
    }
    
    const videoTextData = rekognitionData?.videoTextData || null;
    const rekognitionError = rekognitionData?.error || 'Rekognition branch failed to return data';
    const transcriptionResult = transcriptData.transcriptionResult;

    logger.info('Parallel jobs completed', {
      hasTranscript: !!transcriptData,
      hasVideoText: !!videoTextData,
      rekognitionFailed: !!rekognitionError
    });

    // STEP: Publish transcription completed event
    await context.step('publish-transcription-completed', async () => {
      await publishEvent({
        type: 'TRANSCRIPTION_COMPLETED',
        scanId,
        userId,
        timestamp: new Date().toISOString(),
        data: {
          transcriptLength: transcriptData.fullText.length,
          wordCount: transcriptData.fullText.split(/\s+/).length,
        },
      });
    });

    // STEP: Publish rekognition completed event
    await context.step('publish-rekognition-completed', async () => {
      await publishEvent({
        type: 'REKOGNITION_COMPLETED',
        scanId,
        userId,
        timestamp: new Date().toISOString(),
        data: {
          success: !!videoTextData,
          error: rekognitionError || null,
          textDetected: videoTextData?.detectionCount || 0,
        },
      });
    });

    const warnings: string[] = [];
    if (rekognitionError) {
      warnings.push(`Video text detection failed: ${rekognitionError}`);
    }

    // STEP: Build combined corpus with source mapping
    // Combines audio transcript and video text into single corpus for analysis
    const corpusData = await context.step('build-corpus', async () => {
      return buildCorpus(transcriptData, videoTextData);
    });

    // STEP: Run parallel content analysis on combined corpus
    // Demonstrates context.parallel() for independent analysis tasks
    const analysisResults = await context.parallel([
      async () => analyzeToxicity(corpusData.combinedText),
      async () => analyzeSentiment(corpusData.combinedText),
      async () => detectPII(corpusData.combinedText)
    ]);

    // Extract results from parallel execution
    const toxicityResults = analysisResults.all[0].result as import('./config').ToxicityResult;
    const sentimentResults = analysisResults.all[1].result as import('./config').SentimentResult;
    const piiResults = analysisResults.all[2].result as import('./config').PiiResult;

    logger.info('All analyses completed', {
      toxicity: toxicityResults,
      sentiment: sentimentResults,
      pii: piiResults
    });

    // STEP: Publish analysis completed event
    await context.step('publish-analysis-completed', async () => {
      await publishEvent({
        type: 'ANALYSIS_COMPLETED',
        scanId,
        userId,
        timestamp: new Date().toISOString(),
        data: {
          toxicity: toxicityResults.hasToxicContent,
          sentiment: sentimentResults.sentiment,
          piiDetected: piiResults.hasPII,
        },
      });
    });

    // STEP: Map analysis results back to sources (audio vs screen)
    // Identifies whether issues came from audio transcript or video text
    const mappedResults = await context.step('map-to-sources', async () => {
      return mapResultsToSources(piiResults, corpusData.positionIndex, corpusData.combinedText);
    });

    // STEP: Generate AI summary using Bedrock Nova Lite
    // Creates human-readable summary of all analysis results
    const aiSummary = await context.step('generate-summary', async () => {
      return await generateAISummary(
        toxicityResults,
        sentimentResults,
        piiResults,
        videoTextData,
        mappedResults,
        objectKey,
        objectSize
      );
    });

    // STEP: Save complete results to S3 and DynamoDB
    // Persists full scan report and metadata for retrieval
    const scanRecord = await context.step('save-results', async () => {
      // Determine overall assessment
      let overallAssessment: 'SAFE' | 'CAUTION' | 'UNSAFE' = 'SAFE';
      if (toxicityResults.hasToxicContent || piiResults.hasPII) {
        overallAssessment = 'UNSAFE';
      } else if (sentimentResults.sentiment === 'NEGATIVE' || sentimentResults.sentiment === 'MIXED') {
        overallAssessment = 'CAUTION';
      }
      
      const completedAt = new Date().toISOString();
      const status = videoTextData ? 'completed' : 'partial';
      
      // Build complete result object
      const completeResult = {
        scanId,
        userId,
        objectKey,
        bucketName,
        uploadedAt,
        completedAt,
        fileSize: objectSize,
        overallAssessment,
        status,
        warnings,
        transcriptionResult,
        transcriptData: {
          fullText: transcriptData.fullText,
          transcriptUri: transcriptData.transcriptUri
        },
        videoTextData: videoTextData ? {
          fullText: videoTextData.fullText,
          segmentCount: videoTextData.textSegments.length,
          detectionCount: videoTextData.detectionCount
        } : null,
        analysis: {
          overall: {
            toxicity: toxicityResults,
            sentiment: sentimentResults,
            pii: {
              ...piiResults,
              entities: mappedResults.pii
            }
          },
          summary: mappedResults.summary
        },
        aiSummary
      };
      
      // Save reports to S3
      const { jsonReportKey } = await saveReportsToS3(
        bucketName,
        scanId,
        completeResult
      );
      
      // Save metadata to DynamoDB
      await saveScanMetadata(
        scanId,
        userId,
        objectKey,
        bucketName,
        uploadedAt,
        objectSize,
        overallAssessment,
        status,
        toxicityResults,
        piiResults,
        sentimentResults,
        aiSummary,
        jsonReportKey
      );
      
      return {
        scanId,
        userId,
        uploadedAt,
        jsonReportKey,
        overallAssessment
      };
    });

    // STEP: Publish report generated event
    await context.step('publish-report-generated', async () => {
      await publishEvent({
        type: 'REPORT_GENERATED',
        scanId,
        userId,
        timestamp: new Date().toISOString(),
        data: {
          overallAssessment: scanRecord.overallAssessment,
          jsonReportKey: scanRecord.jsonReportKey,
        },
      });
    });

    // STEP: Publish pending review event
    await context.step('publish-pending-review', async () => {
      await publishEvent({
        type: 'PENDING_REVIEW',
        scanId,
        userId,
        timestamp: new Date().toISOString(),
        data: {
          overallAssessment: scanRecord.overallAssessment,
        },
      });
    });

    // STEP: Wait for human approval with 3-day timeout
    // Demonstrates context.waitForCallback() for human-in-the-loop workflows
    // Suspends execution until admin approves/rejects or timeout occurs
    const approvalResult = await waitForApproval(
      context,
      scanRecord.scanId,
      scanRecord.userId,
      bucketName,
      objectKey
    );
    
    logger.info('Approval result received', { 
      scanId: scanRecord.scanId,
      approvalResult 
    });

    // STEP: Update final approval status in DynamoDB
    // Records the approval decision and updates scan status
    const finalStatus = await context.step('update-approval-status', async () => {
      return await updateApprovalStatus(
        scanRecord.scanId,
        scanRecord.userId,
        scanRecord.uploadedAt,
        objectKey,
        bucketName,
        objectSize,
        scanRecord.overallAssessment,
        videoTextData ? 'completed' : 'partial',
        toxicityResults,
        piiResults,
        sentimentResults,
        aiSummary,
        scanRecord.jsonReportKey,
        approvalResult
      );
    });

    // STEP: Publish final approval status event
    await context.step('publish-approval-status', async () => {
      await publishEvent({
        type: approvalResult.approved ? 'APPROVED' : 'REJECTED',
        scanId,
        userId,
        timestamp: new Date().toISOString(),
        data: {
          approved: approvalResult.approved,
          reviewedBy: approvalResult.reviewedBy,
          comments: approvalResult.comments,
        },
      });
    });

    logger.info('Scanner completed successfully with approval', { 
      scanId: scanRecord.scanId,
      userId: scanRecord.userId,
      overallAssessment: scanRecord.overallAssessment,
      approvalStatus: finalStatus.approvalStatus
    });

    // Return final result
    const result = {
      scanId: scanRecord.scanId,
      userId: scanRecord.userId,
      objectKey,
      objectSize,
      overallAssessment: scanRecord.overallAssessment,
      status: videoTextData ? 'completed' : 'partial',
      approvalStatus: finalStatus.approvalStatus,
      reviewedBy: finalStatus.reviewedBy,
      reviewedAt: finalStatus.reviewedAt,
      reviewComments: finalStatus.comments,
      reportS3Key: scanRecord.jsonReportKey,
      aiSummary: aiSummary.summary,
      warnings
    };

    logger.info('Final scan result', { result });

    return result;
  } catch (error) {
    logger.error('Scanner function failed', {
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : 'Unknown',
      errorStack: error instanceof Error ? error.stack : undefined,
      objectKey,
      objectSize,
      bucketName
    });
    throw error;
  }
});
