import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import { v4 as uuidv4 } from 'uuid';
import { TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand } from '@aws-sdk/client-transcribe';
import { RekognitionClient, StartTextDetectionCommand, GetTextDetectionCommand } from '@aws-sdk/client-rekognition';
import { ComprehendClient, DetectToxicContentCommand, DetectSentimentCommand, DetectPiiEntitiesCommand } from '@aws-sdk/client-comprehend';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Logger } from '@aws-lambda-powertools/logger';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

// @ts-ignore - module resolution issue with util-dynamodb
const { marshall } = require('@aws-sdk/util-dynamodb');

// ============================================================================
// CONFIGURATION
// ============================================================================

const logger = new Logger({ serviceName: 'scanner' });
const transcribe = new TranscribeClient({});
const rekognition = new RekognitionClient({});
const comprehend = new ComprehendClient({});
const bedrock = new BedrockRuntimeClient({});
const ddb = new DynamoDBClient({});
const s3 = new S3Client({});

const SCANNER_TABLE = process.env.SCANNER_TABLE!;
const REKOGNITION_ROLE_ARN = process.env.REKOGNITION_ROLE_ARN!;
const REKOGNITION_SNS_TOPIC_ARN = process.env.REKOGNITION_SNS_TOPIC_ARN!;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'global.amazon.nova-2-lite-v1:0';
const APPSYNC_EVENTS_API_URL = process.env.APPSYNC_EVENTS_API_URL!;
const AWS_REGION = process.env.AWS_REGION || 'us-west-2';

const TIMEOUTS = {
  CALLBACK_SECONDS: 1800,
  APPROVAL_SECONDS: 259200,
  TOKEN_TTL_SECONDS: 86400,
  APPROVAL_TOKEN_TTL_SECONDS: 259200
};

// Development: No retries for fast failure during development/debugging
const CALLBACK_RETRY_STRATEGY = () => ({ shouldRetry: false });

// Production: Exponential backoff retry strategy for transient failures
// Retries up to 3 times with exponential backoff (2s, 4s, 8s)
// const CALLBACK_RETRY_STRATEGY = (attempt: number) => ({
//   shouldRetry: attempt < 3,
//   delayInSeconds: Math.pow(2, attempt) // 2^1=2s, 2^2=4s, 2^3=8s
// });

// ============================================================================
// APPSYNC EVENTS HELPER
// ============================================================================

async function publishEvent(event: {
  type: string;
  scanId: string;
  userId: string;
  timestamp: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  if (!APPSYNC_EVENTS_API_URL) {
    logger.warn('APPSYNC_EVENTS_API_URL not configured, skipping event publish');
    return;
  }

  try {
    const url = new URL(APPSYNC_EVENTS_API_URL);
    const channels = [`/default/scan-updates-${event.userId}`];
    
    if (event.type === 'PENDING_REVIEW') {
      channels.push('/default/admin-pending-reviews');
    }
    
    for (const channel of channels) {
      const body = JSON.stringify({
        channel,
        events: [JSON.stringify(event)],
      });

      const request = new HttpRequest({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'host': url.hostname,
        },
        body,
      });

      const signer = new SignatureV4({
        service: 'appsync',
        region: AWS_REGION,
        credentials: defaultProvider(),
        sha256: Sha256,
      });

      const signedRequest = await signer.sign(request);

      const response = await fetch(`https://${signedRequest.hostname}${signedRequest.path}`, {
        method: signedRequest.method,
        headers: signedRequest.headers as Record<string, string>,
        body: signedRequest.body,
      });

      if (!response.ok) {
        const error = await response.text();
        logger.error('Failed to publish event', { channel, eventType: event.type, status: response.status, error });
      } else {
        logger.info('Successfully published event', { channel, eventType: event.type, scanId: event.scanId });
      }
    }
  } catch (error) {
    logger.error('Error publishing event', { error, eventType: event.type, scanId: event.scanId });
  }
}

// ============================================================================
// MAIN DURABLE FUNCTION
// ============================================================================

export const handler = withDurableExecution(async (event: any, context) => {
  const bucketName = event.detail.bucket.name;
  const objectKey = event.detail.object.key;
  const objectSize = event.detail.object.size;
  const keyParts = objectKey.split('/');
  const userId = keyParts.length >= 2 ? keyParts[1] : 'unknown';

  // ==========================================================================
  // STEP 1: Generate scan ID and timestamp
  // ==========================================================================
  const { scanId, uploadedAt } = await context.step('1-generate-scan-id', async () => ({
    scanId: uuidv4(),
    uploadedAt: new Date().toISOString(),
  }));

  try {
    // Publish scan started event
    await context.step('publish-scan-started', async () => {
      await publishEvent({
        type: 'SCAN_STARTED',
        scanId,
        userId,
        timestamp: new Date().toISOString(),
        data: { objectKey, objectSize },
      });
    });

    // ==========================================================================
    // STEP 2: Parallel - Transcribe + Rekognition
    // Both branches store callback tokens in DynamoDB and wait for async jobs
    // ==========================================================================
    const parallelResults = await context.parallel([
      
      // Branch 1: Transcribe workflow (audio → text)
      async (childContext) => {
        const transcriptionResult = await childContext.waitForCallback<string>(
          '2a-transcription-result',
          async (callbackToken: string) => {
            const jobName = `transcribe-${Date.now()}-${scanId}`;
            
            logger.info('Starting transcription job', { jobName, objectKey, scanId });
            
            // Store callback token in DynamoDB
            await ddb.send(new PutItemCommand({
              TableName: SCANNER_TABLE,
              Item: marshall({
                PK: `SCAN#${scanId}`,
                SK: `TOKEN#${jobName}`,
                EntityType: 'CallbackToken',
                jobName,
                callbackToken,
                bucketName,
                objectKey,
                createdAt: new Date().toISOString(),
                ttl: Math.floor(Date.now() / 1000) + TIMEOUTS.TOKEN_TTL_SECONDS
              })
            }));
            
            logger.info('Callback token stored in DynamoDB', { jobName });
            
            // Start transcription job
            await transcribe.send(new StartTranscriptionJobCommand({
              TranscriptionJobName: jobName,
              LanguageCode: 'en-US',
              MediaFormat: 'mp4',
              Media: { MediaFileUri: `s3://${bucketName}/${objectKey}` },
              OutputBucketName: bucketName,
              OutputKey: `transcripts/${objectKey}.json`
            }));
            
            logger.info('Transcription job started successfully', { jobName });
            
            // Publish transcription started event for immediate UI feedback
            await publishEvent({
              type: 'TRANSCRIPTION_STARTED',
              scanId,
              userId,
              timestamp: new Date().toISOString(),
              data: { jobName },
            });
          },
          { timeout: { seconds: TIMEOUTS.CALLBACK_SECONDS }, retryStrategy: CALLBACK_RETRY_STRATEGY }
        );
        // ============================================================
        // ⏸️  EXECUTION PAUSED ABOVE - Resumed after callback received
        // ============================================================

        // Fetch transcript from S3
        const transcriptData = await childContext.step('2a-fetch-transcript', async () => {
          logger.info('Processing transcription callback result', { transcriptionResult });
          
          const parsedResult = JSON.parse(transcriptionResult);
          const jobDetails = await transcribe.send(new GetTranscriptionJobCommand({
            TranscriptionJobName: parsedResult.jobName
          }));
          
          const transcriptUri = jobDetails.TranscriptionJob?.Transcript?.TranscriptFileUri!;
          
          logger.info('Fetching transcript from S3', { transcriptUri });
          
          let bucket: string;
          let key: string;
          
          const s3UriMatch = transcriptUri.match(/s3:\/\/([^\/]+)\/(.+)/);
          const httpsUriMatch = transcriptUri.match(/https:\/\/s3[.-]([^.]+)\.amazonaws\.com\/([^\/]+)\/(.+)/);
          
          if (s3UriMatch) {
            [, bucket, key] = s3UriMatch;
          } else if (httpsUriMatch) {
            [, , bucket, key] = httpsUriMatch; // Skip first element and region
          } else {
            throw new Error(`Invalid S3 URI format: ${transcriptUri}`);
          }
          
          const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
          const transcriptJson = await response.Body?.transformToString();
          const transcript = JSON.parse(transcriptJson!);
          const fullText = transcript.results?.transcripts?.[0]?.transcript || '';
          
          logger.info('Transcript fetched successfully', { textLength: fullText.length });
          
          return { fullText, transcriptUri, transcript, transcriptionResult };
        });

        return transcriptData;
      },

      // Branch 2: Rekognition workflow (video → text)
      async (childContext) => {
        try {
          const rekognitionResult = await childContext.waitForCallback<string>(
            '2b-rekognition-result',
            async (callbackToken: string) => {
              const jobName = `rekognition-${Date.now()}-${scanId}`;
              
              // Store callback token in DynamoDB
              await ddb.send(new PutItemCommand({
                TableName: SCANNER_TABLE,
                Item: marshall({
                  PK: `SCAN#${scanId}`,
                  SK: `TOKEN#${jobName}`,
                  EntityType: 'CallbackToken',
                  jobName,
                  callbackToken,
                  bucketName,
                  objectKey,
                  jobType: 'rekognition',
                  createdAt: new Date().toISOString(),
                  ttl: Math.floor(Date.now() / 1000) + TIMEOUTS.TOKEN_TTL_SECONDS
                })
              }));
              
              // Start Rekognition text detection job
              await rekognition.send(new StartTextDetectionCommand({
                Video: { S3Object: { Bucket: bucketName, Name: objectKey } },
                NotificationChannel: {
                  SNSTopicArn: REKOGNITION_SNS_TOPIC_ARN,
                  RoleArn: REKOGNITION_ROLE_ARN
                },
                JobTag: jobName
              }));
              
              logger.info('Rekognition text detection job started successfully', { jobName });
              
              // Publish rekognition started event for immediate UI feedback
              await publishEvent({
                type: 'REKOGNITION_STARTED',
                scanId,
                userId,
                timestamp: new Date().toISOString(),
                data: { jobName },
              });
            },
            { timeout: { seconds: TIMEOUTS.CALLBACK_SECONDS }, retryStrategy: CALLBACK_RETRY_STRATEGY }
          );
          // ============================================================
          // ⏸️  EXECUTION PAUSED ABOVE - Resumed after callback received
          // ============================================================

          // Fetch video text results
          const videoTextData = await childContext.step('2b-fetch-video-text', async () => {
            const parsedResult = JSON.parse(rekognitionResult);
            const jobId = parsedResult.jobId;
            
            const textDetections: any[] = [];
            let nextToken: string | undefined;
            
            do {
              const response = await rekognition.send(new GetTextDetectionCommand({
                JobId: jobId,
                NextToken: nextToken
              }));
              if (response.TextDetections) textDetections.push(...response.TextDetections);
              nextToken = response.NextToken;
            } while (nextToken);
            
            const textSegments: any[] = [];
            const seenText = new Map<string, number>();
            
            for (const detection of textDetections) {
              const text = detection.TextDetection?.DetectedText;
              const confidence = detection.TextDetection?.Confidence || 0;
              const timestamp = detection.Timestamp || 0;
              
              if (confidence >= 80 && text && !seenText.has(text)) {
                seenText.set(text, timestamp);
                textSegments.push({
                  text,
                  timestamp: timestamp / 1000,
                  confidence: confidence / 100,
                  boundingBox: detection.TextDetection?.Geometry?.BoundingBox
                });
              }
            }
            
            const fullText = textSegments.map(s => s.text).join(' ');
            return { fullText, textSegments, detectionCount: textDetections.length };
          });

          return { videoTextData, error: null };
        } catch (error) {
          logger.warn('Rekognition failed, continuing with audio-only', { error });
          return { videoTextData: null, error: String(error) };
        }
      }
    ]);

    logger.info('Parallel execution completed', {
      transcriptDataExists: !!parallelResults.all[0]?.result,
      rekognitionDataExists: !!parallelResults.all[1]?.result,
      parallelResultsStructure: JSON.stringify(parallelResults, null, 2)
    });

    const transcriptData = parallelResults.all[0]?.result as any;
    const rekognitionData = parallelResults.all[1]?.result as any;
    const videoTextData = rekognitionData?.videoTextData || null;

    if (!transcriptData) {
      throw new Error('Transcription failed - no transcript data returned');
    }

    // Publish transcription completed event
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

    // Publish rekognition completed event
    await context.step('publish-rekognition-completed', async () => {
      await publishEvent({
        type: 'REKOGNITION_COMPLETED',
        scanId,
        userId,
        timestamp: new Date().toISOString(),
        data: {
          success: !!videoTextData,
          error: rekognitionData?.error || null,
          textDetected: videoTextData?.detectionCount || 0,
        },
      });
    });

    // ==========================================================================
    // STEP 3: Build combined corpus
    // Merge audio transcript + video text with position index for source mapping
    // ==========================================================================
    
    // Publish corpus building event
    await context.step('publish-corpus-building', async () => {
      await publishEvent({
        type: 'BUILDING_CORPUS',
        scanId,
        userId,
        timestamp: new Date().toISOString(),
        data: {},
      });
    });
    
    const corpusData = await context.step('3-build-corpus', async () => {
      const positionIndex: any[] = [];
      let currentOffset = 0;
      
      // Add transcript words with timestamps
      const transcriptItems = transcriptData.transcript?.results?.items || [];
      for (const item of transcriptItems) {
        if (item.type === 'pronunciation' && item.alternatives?.[0]?.content) {
          const word = item.alternatives[0].content;
          const startTime = parseFloat(item.start_time || '0');
          
          positionIndex.push({
            startOffset: currentOffset,
            endOffset: currentOffset + word.length,
            source: 'audio',
            timestamp: startTime,
            text: word
          });
          
          currentOffset += word.length + 1;
        }
      }
      
      // Add video text segments
      if (videoTextData) {
        for (const segment of videoTextData.textSegments) {
          positionIndex.push({
            startOffset: currentOffset,
            endOffset: currentOffset + segment.text.length,
            source: 'screen',
            timestamp: segment.timestamp,
            boundingBox: segment.boundingBox,
            text: segment.text
          });
          
          currentOffset += segment.text.length + 1;
        }
      }
      
      const combinedText = positionIndex.map(p => p.text).join(' ');
      return { combinedText, positionIndex };
    });

    // ==========================================================================
    // STEP 4: Parallel analysis - Toxicity + Sentiment + PII
    // Run all three Comprehend analyses concurrently on combined corpus
    // ==========================================================================
    
    // Publish analysis starting event
    await context.step('publish-analysis-starting', async () => {
      await publishEvent({
        type: 'ANALYSIS_STARTING',
        scanId,
        userId,
        timestamp: new Date().toISOString(),
        data: {},
      });
    });
    
    const analysisResults = await context.parallel([
      
      // Branch 1: Toxicity detection
      async (childContext) => {
        // Publish toxicity started event
        await childContext.step('publish-toxicity-started', async () => {
          await publishEvent({
            type: 'TOXICITY_STARTED',
            scanId,
            userId,
            timestamp: new Date().toISOString(),
            data: {},
          });
        });
        
        const toxicityData = await childContext.step('detect-toxicity', async () => {
          const response = await comprehend.send(new DetectToxicContentCommand({
            TextSegments: [{ Text: corpusData.combinedText }],
            LanguageCode: 'en'
          }));
          
          const labels = (response.ResultList?.[0]?.Labels || []).map(l => ({
            Name: l.Name!,
            Score: l.Score!
          }));
          const hasToxicContent = labels.some(l => l.Score > 0.5);
          
          return { hasToxicContent, labels };
        });
        
        // Publish toxicity completed event
        await childContext.step('publish-toxicity-completed', async () => {
          await publishEvent({
            type: 'TOXICITY_COMPLETED',
            scanId,
            userId,
            timestamp: new Date().toISOString(),
            data: { hasToxicContent: toxicityData.hasToxicContent, labelCount: toxicityData.labels.length },
          });
        });
        
        return toxicityData;
      },
      
      // Branch 2: Sentiment analysis
      async (childContext) => {
        // Publish sentiment started event
        await childContext.step('publish-sentiment-started', async () => {
          await publishEvent({
            type: 'SENTIMENT_STARTED',
            scanId,
            userId,
            timestamp: new Date().toISOString(),
            data: {},
          });
        });
        
        const sentimentData = await childContext.step('detect-sentiment', async () => {
          const response = await comprehend.send(new DetectSentimentCommand({
            Text: corpusData.combinedText.substring(0, 5000), // 5KB limit
            LanguageCode: 'en'
          }));
          
          return {
            sentiment: response.Sentiment!,
            sentimentScore: {
              Positive: response.SentimentScore?.Positive ?? 0,
              Negative: response.SentimentScore?.Negative ?? 0,
              Neutral: response.SentimentScore?.Neutral ?? 0,
              Mixed: response.SentimentScore?.Mixed ?? 0
            }
          };
        });
        
        // Publish sentiment completed event
        await childContext.step('publish-sentiment-completed', async () => {
          await publishEvent({
            type: 'SENTIMENT_COMPLETED',
            scanId,
            userId,
            timestamp: new Date().toISOString(),
            data: { sentiment: sentimentData.sentiment },
          });
        });
        
        return sentimentData;
      },
      
      // Branch 3: PII detection
      async (childContext) => {
        // Publish PII started event
        await childContext.step('publish-pii-started', async () => {
          await publishEvent({
            type: 'PII_STARTED',
            scanId,
            userId,
            timestamp: new Date().toISOString(),
            data: {},
          });
        });
        
        const piiData = await childContext.step('detect-pii', async () => {
          const response = await comprehend.send(new DetectPiiEntitiesCommand({
            Text: corpusData.combinedText.substring(0, 100000), // 100KB limit
            LanguageCode: 'en'
          }));
          
          const entities = (response.Entities || []).map(e => ({
            type: e.Type!,
            score: e.Score!,
            beginOffset: e.BeginOffset!,
            endOffset: e.EndOffset!
          }));
          
          const entityTypes = entities.reduce((acc, e) => {
            acc[e.type] = (acc[e.type] || 0) + 1;
            return acc;
          }, {} as Record<string, number>);
          
          return {
            hasPII: entities.length > 0,
            entityCount: entities.length,
            entityTypes,
            entities
          };
        });
        
        // Publish PII completed event
        await childContext.step('publish-pii-completed', async () => {
          await publishEvent({
            type: 'PII_COMPLETED',
            scanId,
            userId,
            timestamp: new Date().toISOString(),
            data: { hasPII: piiData.hasPII, entityCount: piiData.entityCount },
          });
        });
        
        return piiData;
      }
    ]);

    const toxicityResults = analysisResults.all[0].result as any;
    const sentimentResults = analysisResults.all[1].result as any;
    const piiResults = analysisResults.all[2].result as any;

    // Publish analysis completed event
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

    // ==========================================================================
    // STEP 5: Map results to sources
    // Identify which PII came from audio vs screen
    // ==========================================================================
    const mappedResults = await context.step('5-map-to-sources', async () => {
      const mapOffsetToSource = (offset: number) => {
        for (const pos of corpusData.positionIndex) {
          if (offset >= pos.startOffset && offset < pos.endOffset) {
            return {
              source: pos.source,
              timestamp: pos.timestamp,
              boundingBox: pos.boundingBox,
              text: pos.text
            };
          }
        }
        return null;
      };
      
      const mappedPII = piiResults.entities.map((entity: any) => {
        const sourceInfo = mapOffsetToSource(entity.beginOffset);
        return {
          ...entity,
          source: sourceInfo?.source || 'unknown',
          timestamp: sourceInfo?.timestamp,
          boundingBox: sourceInfo?.boundingBox,
          detectedText: sourceInfo?.text || corpusData.combinedText.substring(entity.beginOffset, entity.endOffset)
        };
      });
      
      const audioIssues = { pii: mappedPII.filter((e: any) => e.source === 'audio').length };
      const screenIssues = { pii: mappedPII.filter((e: any) => e.source === 'screen').length };
      
      return {
        pii: mappedPII,
        summary: { audioIssues, screenIssues }
      };
    });

    // ==========================================================================
    // STEP 6: Generate AI summary
    // Use Bedrock Nova Lite for executive summary
    // ==========================================================================
    
    // Publish AI summary generation starting event
    await context.step('publish-generating-summary', async () => {
      await publishEvent({
        type: 'GENERATING_SUMMARY',
        scanId,
        userId,
        timestamp: new Date().toISOString(),
        data: {},
      });
    });
    
    const aiSummary = await context.step('6-generate-summary', async () => {
      try {
        const prompt = `You are a content moderation assistant. Analyze the following content scan results and provide a concise summary.

VIDEO FILE: ${objectKey}
FILE SIZE: ${(objectSize / 1024 / 1024).toFixed(2)} MB

ANALYSIS RESULTS:

1. TOXICITY DETECTION:
${toxicityResults.hasToxicContent ? 
  `⚠️ TOXIC CONTENT DETECTED\n${toxicityResults.labels.map((l: any) => `   - ${l.Name}: ${(l.Score * 100).toFixed(1)}%`).join('\n')}` :
  '✓ No toxic content detected'}

2. SENTIMENT ANALYSIS:
   Overall Sentiment: ${sentimentResults.sentiment}
   Confidence Scores:
   - Positive: ${(sentimentResults.sentimentScore.Positive * 100).toFixed(1)}%
   - Negative: ${(sentimentResults.sentimentScore.Negative * 100).toFixed(1)}%
   - Neutral: ${(sentimentResults.sentimentScore.Neutral * 100).toFixed(1)}%
   - Mixed: ${(sentimentResults.sentimentScore.Mixed * 100).toFixed(1)}%

3. PII DETECTION:
${piiResults.hasPII ?
  `⚠️ PII DETECTED (${piiResults.entityCount} entities)
   Types found: ${Object.entries(piiResults.entityTypes).map(([type, count]) => `${type} (${count})`).join(', ')}
   
   Source Breakdown:
   - Audio: ${mappedResults.summary.audioIssues.pii} PII entities
   - Screen: ${mappedResults.summary.screenIssues.pii} PII entities` :
  '✓ No PII detected'}

4. VIDEO TEXT DETECTION:
${videoTextData ? 
  `✓ Successfully extracted text from video
   - Unique text segments: ${videoTextData.textSegments.length}
   - Total detections: ${videoTextData.detectionCount}` :
  `⚠️ Video text detection failed or unavailable`}

TASK:
Provide a 3-4 sentence executive summary that:
1. States the overall content safety assessment (Safe/Caution/Unsafe)
2. Highlights the most critical findings
3. Provides a clear recommendation for content moderation action

Keep it concise and actionable.`;

        const requestBody = {
          messages: [{ role: 'user', content: [{ text: prompt }] }],
          inferenceConfig: { maxTokens: 500, temperature: 0.3, topP: 0.9 }
        };

        const response = await bedrock.send(new InvokeModelCommand({
          modelId: BEDROCK_MODEL_ID,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify(requestBody)
        }));

        const responseBody = JSON.parse(new TextDecoder().decode(response.body));
        const summaryText = responseBody.output?.message?.content?.[0]?.text || 'Summary generation failed';

        return {
          summary: summaryText,
          modelId: BEDROCK_MODEL_ID,
          generatedAt: new Date().toISOString()
        };
      } catch (error) {
        logger.error('Failed to generate AI summary', { error });
        return {
          summary: 'AI summary generation failed. Please review raw analysis results.',
          error: String(error),
          generatedAt: new Date().toISOString()
        };
      }
    });

    // ==========================================================================
    // STEP 7: Save results to S3 and DynamoDB
    // Generate JSON report → S3, save metadata → DynamoDB
    // ==========================================================================
    const scanRecord = await context.step('7-save-results', async () => {
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
            pii: { ...piiResults, entities: mappedResults.pii }
          },
          summary: mappedResults.summary
        },
        aiSummary
      };
      
      // Save JSON report to S3
      const jsonReportKey = `reports/${scanId}.json`;
      await s3.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: jsonReportKey,
        Body: JSON.stringify(completeResult, null, 2),
        ContentType: 'application/json'
      }));
      
      // Save metadata to DynamoDB
      await ddb.send(new PutItemCommand({
        TableName: SCANNER_TABLE,
        Item: marshall({
          PK: `SCAN#${scanId}`,
          SK: 'METADATA',
          EntityType: 'ScanResult',
          GSI1PK: `USER#${userId}`,
          GSI1SK: uploadedAt,
          GSI2PK: 'STATUS#PENDING_REVIEW',
          GSI2SK: uploadedAt,
          scanId,
          userId,
          objectKey,
          bucketName,
          status,
          approvalStatus: 'PENDING_REVIEW',
          uploadedAt,
          completedAt,
          fileSize: objectSize,
          overallAssessment,
          hasToxicContent: toxicityResults.hasToxicContent,
          hasPII: piiResults.hasPII,
          sentiment: sentimentResults.sentiment,
          aiSummary: aiSummary.summary,
          reportS3Key: jsonReportKey
        }, { removeUndefinedValues: true })
      }));
      
      return { scanId, userId, uploadedAt, jsonReportKey, overallAssessment };
    });

    // Publish report generated event
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

    // Publish pending review event
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

    // ==========================================================================
    // STEP 8: Wait for human approval
    // Store callback token in DynamoDB, wait up to 3 days, auto-reject on timeout
    // ==========================================================================
    const approvalResult = await context.waitForCallback<any>(
      '8-human-approval',
      async (callbackToken: string) => {
        // Store approval callback token in DynamoDB
        await ddb.send(new PutItemCommand({
          TableName: SCANNER_TABLE,
          Item: marshall({
            PK: `SCAN#${scanId}`,
            SK: 'TOKEN#approval',
            EntityType: 'CallbackToken',
            jobName: `approval-${scanId}`,
            callbackToken,
            scanId,
            userId,
            bucketName,
            objectKey,
            createdAt: new Date().toISOString(),
            ttl: Math.floor(Date.now() / 1000) + TIMEOUTS.APPROVAL_TOKEN_TTL_SECONDS
          })
        }));
        
        logger.info('Approval callback token stored', { scanId, expiresIn: '3 days' });
      },
      {
        timeout: { seconds: TIMEOUTS.APPROVAL_SECONDS },
        retryStrategy: CALLBACK_RETRY_STRATEGY
      }
    );
    // ============================================================
    // ⏸️  EXECUTION PAUSED ABOVE - Resumed after approval/rejection
    // ============================================================
    
    const parsedApproval = typeof approvalResult === 'string' ? JSON.parse(approvalResult) : approvalResult;

    // ==========================================================================
    // STEP 9: Update approval status
    // Record decision in DynamoDB
    // ==========================================================================
    const finalStatus = await context.step('9-update-approval-status', async () => {
      const finalApprovalStatus = parsedApproval.approved ? 'APPROVED' : 'REJECTED';
      const completedAt = new Date().toISOString();
      
      await ddb.send(new PutItemCommand({
        TableName: SCANNER_TABLE,
        Item: marshall({
          PK: `SCAN#${scanId}`,
          SK: 'METADATA',
          EntityType: 'ScanResult',
          GSI1PK: `USER#${userId}`,
          GSI1SK: uploadedAt,
          GSI2PK: `STATUS#${finalApprovalStatus}`,
          GSI2SK: uploadedAt,
          scanId,
          userId,
          objectKey,
          bucketName,
          status: videoTextData ? 'completed' : 'partial',
          approvalStatus: finalApprovalStatus,
          uploadedAt,
          completedAt,
          reviewedAt: parsedApproval.reviewedAt,
          reviewedBy: parsedApproval.reviewedBy,
          reviewComments: parsedApproval.comments || '',
          fileSize: objectSize,
          overallAssessment: scanRecord.overallAssessment,
          hasToxicContent: toxicityResults.hasToxicContent,
          hasPII: piiResults.hasPII,
          sentiment: sentimentResults.sentiment,
          aiSummary: aiSummary.summary,
          reportS3Key: scanRecord.jsonReportKey
        }, { removeUndefinedValues: true })
      }));
      
      return {
        approvalStatus: finalApprovalStatus,
        reviewedBy: parsedApproval.reviewedBy,
        reviewedAt: parsedApproval.reviewedAt,
        comments: parsedApproval.comments
      };
    });

    // Publish approval status event
    await context.step('publish-approval-status', async () => {
      await publishEvent({
        type: parsedApproval.approved ? 'APPROVED' : 'REJECTED',
        scanId,
        userId,
        timestamp: new Date().toISOString(),
        data: {
          approved: parsedApproval.approved,
          reviewedBy: parsedApproval.reviewedBy,
          comments: parsedApproval.comments,
        },
      });
    });

    logger.info('Scanner completed successfully', { 
      scanId,
      userId,
      overallAssessment: scanRecord.overallAssessment,
      approvalStatus: finalStatus.approvalStatus
    });

    return {
      scanId,
      userId,
      objectKey,
      objectSize,
      overallAssessment: scanRecord.overallAssessment,
      status: videoTextData ? 'completed' : 'partial',
      approvalStatus: finalStatus.approvalStatus,
      reviewedBy: finalStatus.reviewedBy,
      reviewedAt: finalStatus.reviewedAt,
      reviewComments: finalStatus.comments,
      reportS3Key: scanRecord.jsonReportKey,
      aiSummary: aiSummary.summary
    };

  } catch (error) {
    logger.error('Scanner function failed', {
      error: error instanceof Error ? error.message : String(error),
      scanId,
      objectKey
    });
    throw error;
  }
});
