import { withDurableExecution, DurableContext } from '@aws/durable-execution-sdk-js';
import { Logger } from '@aws-lambda-powertools/logger';
import { TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand } from '@aws-sdk/client-transcribe';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { ComprehendClient, DetectToxicContentCommand, DetectSentimentCommand, DetectPiiEntitiesCommand } from '@aws-sdk/client-comprehend';
import { RekognitionClient, StartTextDetectionCommand, GetTextDetectionCommand } from '@aws-sdk/client-rekognition';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { v4 as uuidv4 } from 'uuid';

const logger = new Logger({ serviceName: 'scanner' });
const transcribe = new TranscribeClient({});
const ddb = new DynamoDBClient({});
const s3 = new S3Client({});
const comprehend = new ComprehendClient({});
const rekognition = new RekognitionClient({});
const bedrock = new BedrockRuntimeClient({});

const CALLBACK_TOKEN_TABLE = process.env.CALLBACK_TOKEN_TABLE!;
const SCAN_RESULTS_TABLE = process.env.SCAN_RESULTS_TABLE!;
const REKOGNITION_ROLE_ARN = process.env.REKOGNITION_ROLE_ARN!;
const REKOGNITION_SNS_TOPIC_ARN = process.env.REKOGNITION_SNS_TOPIC_ARN!;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'global.amazon.nova-2-lite-v1:0';

// Callback configuration
const CALLBACK_TIMEOUT_SECONDS = 1800; // 30 minutes
const CALLBACK_RETRY_STRATEGY = () => ({ shouldRetry: false }); // No retries

interface S3Event {
  detail: {
    bucket: {
      name: string;
    };
    object: {
      key: string;
      size: number;
    };
  };
}

interface ToxicityResult {
  hasToxicContent: boolean;
  labels?: Array<{ Name: string; Score: number }>;
  chunked?: boolean;
  chunkCount?: number;
  message?: string;
}

interface SentimentResult {
  sentiment: string;
  sentimentScore?: {
    Positive: number;
    Negative: number;
    Neutral: number;
    Mixed: number;
  };
  truncated?: boolean;
  analyzedBytes?: number;
  message?: string;
}

interface PiiResult {
  hasPII: boolean;
  entityCount: number;
  entityTypes: Record<string, number>;
  entities: Array<{
    type: string;
    score: number;
    beginOffset: number;
    endOffset: number;
  }>;
  truncated?: boolean;
  analyzedBytes?: number;
  message?: string;
}

export const handler = withDurableExecution(async (event: S3Event, context: DurableContext) => {
  // logger.info('Scanner function invoked', { event });

  const bucketName = event.detail.bucket.name;
  const objectKey = event.detail.object.key;
  const objectSize = event.detail.object.size;

  try {

  // Steps 1-4: Run Transcribe and Rekognition in parallel
  const parallelResults = await context.parallel([
    // Branch 1: Transcription workflow
    async (childContext) => {
      // Step 1: Start transcription and wait for callback
      const transcriptionResult = await childContext.waitForCallback<string>(
        'transcription-result',
        async (callbackToken: string) => {
          const jobName = `transcribe-${Date.now()}-${objectKey.replace(/[^a-zA-Z0-9-_]/g, '_')}`;
          
          logger.info('Starting transcription job', { jobName, objectKey });
          
          try {
            // Store callback token in DynamoDB
            await ddb.send(new PutItemCommand({
              TableName: CALLBACK_TOKEN_TABLE,
              Item: marshall({
                jobName,
                callbackToken,
                bucketName,
                objectKey,
                createdAt: new Date().toISOString(),
                ttl: Math.floor(Date.now() / 1000) + 86400 // 24 hours TTL
              })
            }));
            
            logger.info('Callback token stored in DynamoDB', { jobName });
            
            const command = new StartTranscriptionJobCommand({
              TranscriptionJobName: jobName,
              LanguageCode: 'en-US',
              MediaFormat: 'mp4',
              Media: {
                MediaFileUri: `s3://${bucketName}/${objectKey}`
              },
              OutputBucketName: bucketName,
              OutputKey: `transcripts/${objectKey}.json`,
              Tags: [
                {
                  Key: 'SourceBucket',
                  Value: bucketName
                },
                {
                  Key: 'SourceKey',
                  Value: objectKey
                }
              ]
            });
            
            const response = await transcribe.send(command);
            
            logger.info('Transcription job started successfully', { 
              jobName, 
              status: response.TranscriptionJob?.TranscriptionJobStatus 
            });
          } catch (error) {
            logger.error('Failed to start transcription job', { 
              jobName, 
              error: error instanceof Error ? error.message : String(error),
              errorName: error instanceof Error ? error.name : 'Unknown',
              objectKey,
              bucketName
            });
            throw error;
          }
        },
        {
          timeout: {seconds: CALLBACK_TIMEOUT_SECONDS},
          retryStrategy: CALLBACK_RETRY_STRATEGY
        }
      );

      // Step 2: Fetch transcript from S3
      const transcriptData = await childContext.step('fetch-transcript', async () => {
        logger.info('Processing transcription callback result', { transcriptionResult });
        
        const parsedResult = typeof transcriptionResult === 'string' 
          ? JSON.parse(transcriptionResult) 
          : transcriptionResult;
        
        // Fetch full transcription job details
        const jobDetails = await transcribe.send(new GetTranscriptionJobCommand({
          TranscriptionJobName: parsedResult.jobName
        }));
        
        const transcriptUri = jobDetails.TranscriptionJob?.Transcript?.TranscriptFileUri;
        
        if (!transcriptUri) {
          throw new Error('No transcript URI found in transcription job details');
        }
        
        logger.info('Fetching transcript from S3', { transcriptUri });
        
        let bucket: string;
        let key: string;
        
        // Parse S3 URI - can be s3://bucket/key or https://s3.region.amazonaws.com/bucket/key
        const s3UriMatch = transcriptUri.match(/s3:\/\/([^\/]+)\/(.+)/);
        const httpsUriMatch = transcriptUri.match(/https:\/\/s3[.-]([^.]+)\.amazonaws\.com\/([^\/]+)\/(.+)/);
        
        if (s3UriMatch) {
          [, bucket, key] = s3UriMatch;
        } else if (httpsUriMatch) {
          // httpsUriMatch: [full, region, bucket, key]
          bucket = httpsUriMatch[2];
          key = httpsUriMatch[3];
        } else {
          throw new Error(`Invalid S3 URI format: ${transcriptUri}`);
        }
        
        logger.info('Fetching transcript file', { bucket, key });
        
        const response = await s3.send(new GetObjectCommand({
          Bucket: bucket,
          Key: key
        }));
        
        const transcriptJson = await response.Body?.transformToString();
        if (!transcriptJson) {
          throw new Error('Empty transcript file');
        }
        
        const transcript = JSON.parse(transcriptJson);
        const fullText = transcript.results?.transcripts?.[0]?.transcript || '';
        
        logger.info('Transcript fetched successfully', { 
          textLength: fullText.length,
          bucket,
          key
        });
        
        return {
          fullText,
          transcriptUri,
          transcript,
          transcriptionResult
        };
      });

      return transcriptData;
    },

    // Branch 2: Rekognition workflow
    async (childContext) => {
      try {
        // Step 3: Start Rekognition and wait for callback
        const rekognitionResult = await childContext.waitForCallback<string>(
          'rekognition-result',
          async (callbackToken: string) => {
            const jobName = `rekognition-${Date.now()}-${objectKey.replace(/[^a-zA-Z0-9-_]/g, '_')}`;
            
            logger.info('Starting Rekognition text detection job', { jobName, objectKey });
            
            try {
              // Store callback token in DynamoDB
              await ddb.send(new PutItemCommand({
                TableName: CALLBACK_TOKEN_TABLE,
                Item: marshall({
                  jobName,
                  callbackToken,
                  bucketName,
                  objectKey,
                  jobType: 'rekognition',
                  createdAt: new Date().toISOString(),
                  ttl: Math.floor(Date.now() / 1000) + 86400 // 24 hours TTL
                })
              }));
              
              logger.info('Rekognition callback token stored in DynamoDB', { jobName });
              
              const command = new StartTextDetectionCommand({
                Video: {
                  S3Object: {
                    Bucket: bucketName,
                    Name: objectKey
                  }
                },
                NotificationChannel: {
                  SNSTopicArn: REKOGNITION_SNS_TOPIC_ARN,
                  RoleArn: REKOGNITION_ROLE_ARN
                },
                JobTag: jobName
              });
              
              const response = await rekognition.send(command);
              
              logger.info('Rekognition text detection job started successfully', { 
                jobName,
                jobId: response.JobId
              });
            } catch (error) {
              logger.error('Failed to start Rekognition text detection job', { 
                jobName, 
                error: error instanceof Error ? error.message : String(error),
                errorName: error instanceof Error ? error.name : 'Unknown',
                objectKey,
                bucketName
              });
              throw error;
            }
          },
          {
            timeout: {seconds: CALLBACK_TIMEOUT_SECONDS},
            retryStrategy: CALLBACK_RETRY_STRATEGY
          }
        );

        // Step 4: Fetch Rekognition results and extract video text
        const videoTextData = await childContext.step('fetch-video-text', async () => {
          logger.info('Fetching Rekognition results', { rekognitionResult });
          
          const parsedResult = typeof rekognitionResult === 'string' 
            ? JSON.parse(rekognitionResult) 
            : rekognitionResult;
          
          const jobId = parsedResult.jobId;
          if (!jobId) {
            throw new Error('No job ID found in Rekognition result');
          }
          
          logger.info('Fetching text detection results', { jobId });
          
          // Fetch all pages of results
          const textDetections: any[] = [];
          let nextToken: string | undefined;
          
          do {
            const response = await rekognition.send(new GetTextDetectionCommand({
              JobId: jobId,
              NextToken: nextToken
            }));
            
            if (response.TextDetections) {
              textDetections.push(...response.TextDetections);
            }
            
            nextToken = response.NextToken;
          } while (nextToken);
          
          logger.info('Fetched text detections', { count: textDetections.length });
          
          // Extract and deduplicate text with timestamps
          const textSegments: Array<{
            text: string;
            timestamp: number;
            confidence: number;
            boundingBox?: any;
          }> = [];
          
          const seenText = new Map<string, number>(); // text -> first timestamp
          
          for (const detection of textDetections) {
            const text = detection.TextDetection?.DetectedText;
            const confidence = detection.TextDetection?.Confidence || 0;
            const timestamp = detection.Timestamp || 0;
            
            // Filter by confidence threshold
            if (confidence < 80) continue;
            
            if (text && !seenText.has(text)) {
              seenText.set(text, timestamp);
              textSegments.push({
                text,
                timestamp: timestamp / 1000, // Convert ms to seconds
                confidence: confidence / 100, // Convert to 0-1 range
                boundingBox: detection.TextDetection?.Geometry?.BoundingBox
              });
            }
          }
          
          // Combine all unique text
          const fullText = textSegments.map(s => s.text).join(' ');
          
          logger.info('Video text extracted', { 
            segmentCount: textSegments.length,
            textLength: fullText.length
          });
          
          return {
            fullText,
            textSegments,
            detectionCount: textDetections.length
          };
        });

        return { videoTextData, error: null };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn('Rekognition text detection failed, continuing with audio-only analysis', {
          error: errorMessage,
          errorName: error instanceof Error ? error.name : 'Unknown',
          objectKey
        });
        return { videoTextData: null, error: errorMessage };
      }
    }
  ]);

  // Extract results from parallel execution
  const transcriptData = parallelResults.all[0].result as {
    fullText: string;
    transcriptUri: string;
    transcript: any;
    transcriptionResult: string;
  };
  const rekognitionData = parallelResults.all[1].result as {
    videoTextData: {
      fullText: string;
      textSegments: Array<{
        text: string;
        timestamp: number;
        confidence: number;
        boundingBox?: any;
      }>;
      detectionCount: number;
    } | null;
    error: string | null;
  };
  const videoTextData = rekognitionData.videoTextData;
  const rekognitionError = rekognitionData.error;
  const transcriptionResult = transcriptData.transcriptionResult;

  logger.info('Parallel jobs completed', {
    hasTranscript: !!transcriptData,
    hasVideoText: !!videoTextData,
    rekognitionFailed: !!rekognitionError
  });

  // Step 5: Build combined corpus with source mapping
  const corpusData = await context.step('build-corpus', async () => {
    logger.info('Building corpus', { hasVideoText: !!videoTextData });
    
    // Build position index for mapping offsets back to source
    const positionIndex: Array<{
      startOffset: number;
      endOffset: number;
      source: 'audio' | 'screen';
      timestamp?: number;
      boundingBox?: any;
      text: string;
    }> = [];
    
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
        
        currentOffset += word.length + 1; // +1 for space
      }
    }
    
    // Add video text segments with timestamps (if available)
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
        
        currentOffset += segment.text.length + 1; // +1 for space
      }
    }
    
    // Combine all text
    const combinedText = positionIndex.map(p => p.text).join(' ');
    
    logger.info('Corpus built', {
      totalLength: combinedText.length,
      audioSegments: positionIndex.filter(p => p.source === 'audio').length,
      screenSegments: positionIndex.filter(p => p.source === 'screen').length
    });
    
    return {
      combinedText,
      positionIndex
    };
  });

  // Step 6: Run parallel content analysis on combined corpus
  const analysisResults = await context.parallel([
    // Branch 1: Toxicity Detection
    async () => {
      logger.info('Checking toxicity', { textLength: corpusData.combinedText.length });
      
      const text = corpusData.combinedText;
      
      if (!text || text.trim().length === 0) {
        logger.warn('No text to analyze for toxicity');
        return {
          hasToxicContent: false,
          message: 'No text content to analyze'
        };
      }
      
      // Comprehend has a 100KB limit per request
      const MAX_BYTES = 100000;
      const textBytes = Buffer.byteLength(text, 'utf8');
      
      if (textBytes > MAX_BYTES) {
        // For large texts, chunk and analyze
        logger.info('Text exceeds 100KB, chunking for analysis', { textBytes });
        
        const chunks: string[] = [];
        let currentChunk = '';
        const words = text.split(/\s+/);
        
        for (const word of words) {
          const testChunk = currentChunk + (currentChunk ? ' ' : '') + word;
          if (Buffer.byteLength(testChunk, 'utf8') > MAX_BYTES) {
            if (currentChunk) chunks.push(currentChunk);
            currentChunk = word;
          } else {
            currentChunk = testChunk;
          }
        }
        if (currentChunk) chunks.push(currentChunk);
        
        logger.info('Analyzing chunks', { chunkCount: chunks.length });
        
        // Analyze each chunk
        const chunkResults = await Promise.all(
          chunks.map(async (chunk, index) => {
            const response = await comprehend.send(new DetectToxicContentCommand({
              TextSegments: [{ Text: chunk }],
              LanguageCode: 'en'
            }));
            
            return {
              chunkIndex: index,
              labels: response.ResultList?.[0]?.Labels || []
            };
          })
        );
        
        // Aggregate results - take max score for each label type
        const aggregatedLabels = new Map<string, number>();
        
        for (const result of chunkResults) {
          for (const label of result.labels) {
            const name = label.Name!;
            const score = label.Score!;
            const currentMax = aggregatedLabels.get(name) || 0;
            aggregatedLabels.set(name, Math.max(currentMax, score));
          }
        }
        
        const labels = Array.from(aggregatedLabels.entries()).map(([name, score]) => ({
          Name: name,
          Score: score
        }));
        
        const hasToxicContent = labels.some(label => label.Score > 0.5);
        
        logger.info('Toxicity analysis completed (chunked)', { 
          hasToxicContent,
          labelCount: labels.length,
          chunkCount: chunks.length
        });
        
        return {
          hasToxicContent,
          labels,
          chunked: true,
          chunkCount: chunks.length
        };
      } else {
        // Single request for smaller texts
        const response = await comprehend.send(new DetectToxicContentCommand({
          TextSegments: [{ Text: text }],
          LanguageCode: 'en'
        }));
        
        const labels = response.ResultList?.[0]?.Labels || [];
        const hasToxicContent = labels.some(label => label.Score! > 0.5);
        
        logger.info('Toxicity analysis completed', { 
          hasToxicContent,
          labelCount: labels.length
        });
        
        return {
          hasToxicContent,
          labels,
          chunked: false
        };
      }
    },
    
    // Branch 2: Sentiment Analysis
    async () => {
      logger.info('Analyzing sentiment', { textLength: corpusData.combinedText.length });
      
      const text = corpusData.combinedText;
      
      if (!text || text.trim().length === 0) {
        logger.warn('No text to analyze for sentiment');
        return {
          sentiment: 'NEUTRAL',
          message: 'No text content to analyze'
        };
      }
      
      // Comprehend sentiment has a 5KB limit
      const MAX_BYTES = 5000;
      const textBytes = Buffer.byteLength(text, 'utf8');
      
      // If text is too large, analyze first 5KB
      const textToAnalyze = textBytes > MAX_BYTES 
        ? text.substring(0, Math.floor(text.length * (MAX_BYTES / textBytes)))
        : text;
      
      const response = await comprehend.send(new DetectSentimentCommand({
        Text: textToAnalyze,
        LanguageCode: 'en'
      }));
      
      logger.info('Sentiment analysis completed', { 
        sentiment: response.Sentiment,
        truncated: textBytes > MAX_BYTES
      });
      
      return {
        sentiment: response.Sentiment,
        sentimentScore: response.SentimentScore,
        truncated: textBytes > MAX_BYTES,
        analyzedBytes: Buffer.byteLength(textToAnalyze, 'utf8')
      };
    },
    
    // Branch 3: PII Detection
    async () => {
      logger.info('Detecting PII', { textLength: corpusData.combinedText.length });
      
      const text = corpusData.combinedText;
      
      if (!text || text.trim().length === 0) {
        logger.warn('No text to analyze for PII');
        return {
          hasPII: false,
          entities: [],
          message: 'No text content to analyze'
        };
      }
      
      // Comprehend PII has a 100KB limit
      const MAX_BYTES = 100000;
      const textBytes = Buffer.byteLength(text, 'utf8');
      
      // If text is too large, analyze first 100KB
      const textToAnalyze = textBytes > MAX_BYTES 
        ? text.substring(0, Math.floor(text.length * (MAX_BYTES / textBytes)))
        : text;
      
      const response = await comprehend.send(new DetectPiiEntitiesCommand({
        Text: textToAnalyze,
        LanguageCode: 'en'
      }));
      
      const entities = response.Entities || [];
      const hasPII = entities.length > 0;
      
      // Group by type for summary
      const entityTypes = entities.reduce((acc, entity) => {
        const type = entity.Type!;
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      logger.info('PII detection completed', { 
        hasPII,
        entityCount: entities.length,
        entityTypes: Object.keys(entityTypes),
        truncated: textBytes > MAX_BYTES
      });
      
      return {
        hasPII,
        entityCount: entities.length,
        entityTypes,
        entities: entities.map(e => ({
          type: e.Type,
          score: e.Score,
          beginOffset: e.BeginOffset,
          endOffset: e.EndOffset
        })),
        truncated: textBytes > MAX_BYTES,
        analyzedBytes: Buffer.byteLength(textToAnalyze, 'utf8')
      };
    }
  ]);

  // Log what parallel returns for debugging
  logger.info('Parallel execution completed', { 
    analysisResults,
    type: typeof analysisResults,
    isArray: Array.isArray(analysisResults)
  });

  // Extract results from parallel execution - parallel returns an object with 'all' array
  const toxicityResults = analysisResults.all[0].result as ToxicityResult;
  const sentimentResults = analysisResults.all[1].result as SentimentResult;
  const piiResults = analysisResults.all[2].result as PiiResult;

  logger.info('All analyses completed', {
    toxicity: toxicityResults,
    sentiment: sentimentResults,
    pii: piiResults
  });

  // Step 7: Map results back to sources
  const mappedResults = await context.step('map-to-sources', async () => {
    logger.info('Mapping results to sources');
    
    // Helper function to map character offset to source
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
    
    // Map PII entities to sources
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
    
    // Group by source
    const audioIssues = {
      pii: mappedPII.filter((e: any) => e.source === 'audio').length
    };
    
    const screenIssues = {
      pii: mappedPII.filter((e: any) => e.source === 'screen').length
    };
    
    logger.info('Source mapping completed', {
      audioIssues,
      screenIssues
    });
    
    return {
      pii: mappedPII,
      summary: {
        audioIssues,
        screenIssues
      }
    };
  });

  // Finalize
  logger.info('Scanner completed', { 
    objectKey,
    objectSize,
    hasToxicContent: toxicityResults.hasToxicContent,
    sentiment: sentimentResults.sentiment,
    hasPII: piiResults.hasPII,
    hasVideoText: !!videoTextData,
    status: videoTextData ? 'completed' : 'partial'
  });

  const warnings: string[] = [];
  if (rekognitionError) {
    warnings.push(`Video text detection failed: ${rekognitionError}`);
  }

  // Step 8: Generate AI summary using Nova Lite
  const aiSummary = await context.step('generate-summary', async () => {
    logger.info('Generating AI summary with Nova Lite');
    
    try {
      // Build structured prompt with analysis results
      const prompt = `You are a content moderation assistant. Analyze the following content scan results and provide a concise summary.

VIDEO FILE: ${objectKey}
FILE SIZE: ${(objectSize / 1024 / 1024).toFixed(2)} MB

ANALYSIS RESULTS:

1. TOXICITY DETECTION:
${toxicityResults.hasToxicContent ? 
  `⚠️ TOXIC CONTENT DETECTED
${(toxicityResults.labels || []).map((l: any) => `   - ${l.Name}: ${(l.Score * 100).toFixed(1)}%`).join('\n')}` :
  '✓ No toxic content detected'}

2. SENTIMENT ANALYSIS:
   Overall Sentiment: ${sentimentResults.sentiment}
${sentimentResults.sentimentScore ? 
  `   Confidence Scores:
   - Positive: ${(sentimentResults.sentimentScore.Positive * 100).toFixed(1)}%
   - Negative: ${(sentimentResults.sentimentScore.Negative * 100).toFixed(1)}%
   - Neutral: ${(sentimentResults.sentimentScore.Neutral * 100).toFixed(1)}%
   - Mixed: ${(sentimentResults.sentimentScore.Mixed * 100).toFixed(1)}%` : ''}

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
        messages: [
          {
            role: 'user',
            content: [{ text: prompt }]
          }
        ],
        inferenceConfig: {
          maxTokens: 500,
          temperature: 0.3,
          topP: 0.9
        }
      };

      const command = new InvokeModelCommand({
        modelId: BEDROCK_MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(requestBody)
      });

      const response = await bedrock.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));
      
      const summaryText = responseBody.output?.message?.content?.[0]?.text || 'Summary generation failed';
      
      logger.info('AI summary generated successfully', { 
        summaryLength: summaryText.length,
        modelId: BEDROCK_MODEL_ID
      });

      return {
        summary: summaryText,
        modelId: BEDROCK_MODEL_ID,
        generatedAt: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Failed to generate AI summary', {
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : 'Unknown'
      });
      
      // Return fallback summary if Bedrock fails
      return {
        summary: 'AI summary generation failed. Please review raw analysis results.',
        error: error instanceof Error ? error.message : String(error),
        generatedAt: new Date().toISOString()
      };
    }
  });

  // Step 9: Save results to S3 and DynamoDB
  const scanRecord = await context.step('save-results', async () => {
    logger.info('Saving scan results');
    
    const scanId = uuidv4();
    const uploadedAt = new Date().toISOString();
    
    // Extract userId from objectKey (format: raw/{userId}/{filename})
    const keyParts = objectKey.split('/');
    const userId = keyParts.length >= 2 ? keyParts[1] : 'unknown';
    
    // Determine overall assessment
    let overallAssessment: 'SAFE' | 'CAUTION' | 'UNSAFE' = 'SAFE';
    if (toxicityResults.hasToxicContent || piiResults.hasPII) {
      overallAssessment = 'UNSAFE';
    } else if (sentimentResults.sentiment === 'NEGATIVE' || sentimentResults.sentiment === 'MIXED') {
      overallAssessment = 'CAUTION';
    }
    
    // Build complete result object
    const completeResult = {
      scanId,
      userId,
      objectKey,
      bucketName,
      uploadedAt,
      completedAt: new Date().toISOString(),
      fileSize: objectSize,
      overallAssessment,
      status: videoTextData ? 'completed' : 'partial',
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
    
    // Save full JSON report to S3
    const jsonReportKey = `reports/${scanId}.json`;
    await s3.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: jsonReportKey,
      Body: JSON.stringify(completeResult, null, 2),
      ContentType: 'application/json'
    }));
    
    logger.info('JSON report saved to S3', { jsonReportKey });
    
    // Generate HTML report
    const htmlReport = generateHtmlReport(completeResult);
    const htmlReportKey = `reports/${scanId}.html`;
    
    await s3.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: htmlReportKey,
      Body: htmlReport,
      ContentType: 'text/html'
    }));
    
    logger.info('HTML report saved to S3', { htmlReportKey });
    
    // Save metadata to DynamoDB
    await ddb.send(new PutItemCommand({
      TableName: SCAN_RESULTS_TABLE,
      Item: marshall({
        scanId,
        userId,
        objectKey,
        bucketName,
        status: completeResult.status,
        approvalStatus: 'PENDING_REVIEW',
        uploadedAt,
        completedAt: completeResult.completedAt,
        fileSize: objectSize,
        overallAssessment,
        hasToxicContent: toxicityResults.hasToxicContent,
        hasPII: piiResults.hasPII,
        sentiment: sentimentResults.sentiment,
        aiSummary: aiSummary.summary,
        reportS3Key: jsonReportKey,
        htmlReportS3Key: htmlReportKey
      }, { removeUndefinedValues: true })
    }));
    
    logger.info('Scan metadata saved to DynamoDB', { scanId, userId });
    
    return {
      scanId,
      userId,
      uploadedAt,
      jsonReportKey,
      htmlReportKey,
      overallAssessment
    };
  });

  // Step 10: Wait for human approval with 3-day timeout
  let approvalResult: {
    approved: boolean;
    reviewedBy: string;
    reviewedAt: string;
    comments?: string;
  };
  
  try {
    approvalResult = await context.waitForCallback<{
      approved: boolean;
      reviewedBy: string;
      reviewedAt: string;
      comments?: string;
    }>(
      'human-approval',
      async (callbackToken: string) => {
        logger.info('Waiting for human approval', { 
          scanId: scanRecord.scanId,
          callbackToken 
        });
        
        // Store callback token in DynamoDB for approval workflow
        await ddb.send(new PutItemCommand({
          TableName: CALLBACK_TOKEN_TABLE,
          Item: marshall({
            jobName: `approval-${scanRecord.scanId}`,
            callbackToken,
            scanId: scanRecord.scanId,
            userId: scanRecord.userId,
            bucketName,
            objectKey,
            createdAt: new Date().toISOString(),
            ttl: Math.floor(Date.now() / 1000) + (3 * 86400) // 3 days TTL
          })
        }));
        
        logger.info('Approval callback token stored', { 
          scanId: scanRecord.scanId,
          expiresIn: '3 days'
        });
      },
      {
        timeout: { seconds: 259200 }, // 3 days = 259200 seconds
        retryStrategy: CALLBACK_RETRY_STRATEGY
      }
    );
  } catch (error) {
    // Handle timeout - auto-reject after 3 days
    logger.warn('Approval timeout - auto-rejecting', {
      scanId: scanRecord.scanId,
      error: error instanceof Error ? error.message : String(error)
    });
    
    approvalResult = {
      approved: false,
      reviewedBy: 'system',
      reviewedAt: new Date().toISOString(),
      comments: 'Auto-rejected due to 3-day approval timeout'
    };
  }

  // Step 11: Update final approval status
  const finalStatus = await context.step('update-approval-status', async () => {
    logger.info('Updating approval status', { 
      scanId: scanRecord.scanId,
      approved: approvalResult.approved 
    });
    
    const finalApprovalStatus = approvalResult.approved ? 'APPROVED' : 'REJECTED';
    const completedAt = new Date().toISOString();
    
    // Update DynamoDB with final approval status
    await ddb.send(new PutItemCommand({
      TableName: SCAN_RESULTS_TABLE,
      Item: marshall({
        scanId: scanRecord.scanId,
        userId: scanRecord.userId,
        objectKey,
        bucketName,
        status: videoTextData ? 'completed' : 'partial',
        approvalStatus: finalApprovalStatus,
        uploadedAt: scanRecord.uploadedAt,
        completedAt,
        reviewedAt: approvalResult.reviewedAt,
        reviewedBy: approvalResult.reviewedBy,
        reviewComments: approvalResult.comments || '',
        fileSize: objectSize,
        overallAssessment: scanRecord.overallAssessment,
        hasToxicContent: toxicityResults.hasToxicContent,
        hasPII: piiResults.hasPII,
        sentiment: sentimentResults.sentiment,
        aiSummary: aiSummary.summary,
        reportS3Key: scanRecord.jsonReportKey,
        htmlReportS3Key: scanRecord.htmlReportKey
      }, { removeUndefinedValues: true })
    }));
    
    logger.info('Approval status updated in DynamoDB', { 
      scanId: scanRecord.scanId,
      finalApprovalStatus 
    });
    
    return {
      approvalStatus: finalApprovalStatus,
      reviewedBy: approvalResult.reviewedBy,
      reviewedAt: approvalResult.reviewedAt,
      comments: approvalResult.comments
    };
  });

  logger.info('Scanner completed successfully with approval', { 
    scanId: scanRecord.scanId,
    userId: scanRecord.userId,
    overallAssessment: scanRecord.overallAssessment,
    approvalStatus: finalStatus.approvalStatus
  });

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
    htmlReportS3Key: scanRecord.htmlReportKey,
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

// HTML Report Generator
function generateHtmlReport(result: {
  scanId: string;
  userId: string;
  objectKey: string;
  bucketName: string;
  uploadedAt: string;
  completedAt: string;
  fileSize: number;
  overallAssessment: 'SAFE' | 'CAUTION' | 'UNSAFE';
  status: string;
  warnings: string[];
  aiSummary: {
    summary: string;
    modelId?: string;
    generatedAt: string;
    error?: string;
  };
  analysis: {
    overall: {
      toxicity: ToxicityResult;
      sentiment: SentimentResult;
      pii: PiiResult & {
        entities: Array<{
          type: string;
          score: number;
          beginOffset: number;
          endOffset: number;
          source?: string;
          timestamp?: number;
          boundingBox?: any;
          detectedText?: string;
        }>;
      };
    };
    summary: {
      audioIssues: { pii: number };
      screenIssues: { pii: number };
    };
  };
  videoTextData: {
    fullText: string;
    segmentCount: number;
    detectionCount: number;
  } | null;
}): string {
  const statusColor: Record<'SAFE' | 'CAUTION' | 'UNSAFE', string> = {
    SAFE: '#10b981',
    CAUTION: '#f59e0b',
    UNSAFE: '#ef4444'
  };

  const statusIcon: Record<'SAFE' | 'CAUTION' | 'UNSAFE', string> = {
    SAFE: '✓',
    CAUTION: '⚠',
    UNSAFE: '✗'
  };

  const currentStatusColor = statusColor[result.overallAssessment];
  const currentStatusIcon = statusIcon[result.overallAssessment];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Content Scan Report - ${result.scanId}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #1f2937;
      background: #f9fafb;
      padding: 2rem;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      border-radius: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 2rem;
    }
    .header h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    .header p { opacity: 0.9; }
    .content { padding: 2rem; }
    .section {
      margin-bottom: 2rem;
      padding-bottom: 2rem;
      border-bottom: 1px solid #e5e7eb;
    }
    .section:last-child { border-bottom: none; }
    .section h2 {
      font-size: 1.5rem;
      margin-bottom: 1rem;
      color: #111827;
    }
    .assessment-badge {
      display: inline-block;
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      font-size: 1.25rem;
      font-weight: 600;
      color: white;
      background: ${currentStatusColor};
      margin: 1rem 0;
    }
    .info-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 1rem;
      margin: 1rem 0;
    }
    .info-item {
      background: #f9fafb;
      padding: 1rem;
      border-radius: 8px;
      border-left: 4px solid #667eea;
    }
    .info-label {
      font-size: 0.875rem;
      color: #6b7280;
      margin-bottom: 0.25rem;
    }
    .info-value {
      font-size: 1.125rem;
      font-weight: 600;
      color: #111827;
    }
    .finding {
      background: #fef3c7;
      border-left: 4px solid #f59e0b;
      padding: 1rem;
      margin: 0.5rem 0;
      border-radius: 4px;
    }
    .finding.safe {
      background: #d1fae5;
      border-left-color: #10b981;
    }
    .finding.danger {
      background: #fee2e2;
      border-left-color: #ef4444;
    }
    .finding-title {
      font-weight: 600;
      margin-bottom: 0.5rem;
    }
    .entity-list {
      margin: 0.5rem 0;
      padding-left: 1.5rem;
    }
    .entity-item {
      margin: 0.25rem 0;
      font-size: 0.875rem;
    }
    .approval-section {
      background: #f3f4f6;
      padding: 1.5rem;
      border-radius: 8px;
      margin-top: 1rem;
    }
    .approval-status {
      display: inline-block;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      font-weight: 600;
      background: #fbbf24;
      color: #78350f;
    }
    .footer {
      background: #f9fafb;
      padding: 1.5rem 2rem;
      text-align: center;
      color: #6b7280;
      font-size: 0.875rem;
    }
    .ai-summary {
      background: #ede9fe;
      border-left: 4px solid #8b5cf6;
      padding: 1.5rem;
      border-radius: 8px;
      margin: 1rem 0;
      font-size: 1.05rem;
      line-height: 1.8;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Content Scan Report</h1>
      <p>Scan ID: ${result.scanId}</p>
      <p>Generated: ${new Date(result.completedAt).toLocaleString()}</p>
    </div>

    <div class="content">
      <!-- Overall Assessment -->
      <div class="section">
        <h2>Overall Assessment</h2>
        <div class="assessment-badge">
          ${currentStatusIcon} ${result.overallAssessment}
        </div>
        
        <div class="ai-summary">
          <strong>AI Summary:</strong><br>
          ${result.aiSummary.summary}
        </div>

        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">User ID</div>
            <div class="info-value">${result.userId}</div>
          </div>
          <div class="info-item">
            <div class="info-label">File</div>
            <div class="info-value">${result.objectKey.split('/').pop()}</div>
          </div>
          <div class="info-item">
            <div class="info-label">File Size</div>
            <div class="info-value">${(result.fileSize / 1024 / 1024).toFixed(2)} MB</div>
          </div>
          <div class="info-item">
            <div class="info-label">Status</div>
            <div class="info-value">${result.status.toUpperCase()}</div>
          </div>
        </div>
      </div>

      <!-- Toxicity Analysis -->
      <div class="section">
        <h2>Toxicity Analysis</h2>
        ${result.analysis.overall.toxicity.hasToxicContent ? `
          <div class="finding danger">
            <div class="finding-title">⚠️ Toxic Content Detected</div>
            <ul class="entity-list">
              ${(result.analysis.overall.toxicity.labels || []).map((l: any) => 
                `<li class="entity-item">${l.Name}: ${(l.Score * 100).toFixed(1)}% confidence</li>`
              ).join('')}
            </ul>
          </div>
        ` : `
          <div class="finding safe">
            <div class="finding-title">✓ No Toxic Content Detected</div>
            <p>The content passed toxicity screening.</p>
          </div>
        `}
      </div>

      <!-- Sentiment Analysis -->
      <div class="section">
        <h2>Sentiment Analysis</h2>
        <div class="finding ${result.analysis.overall.sentiment.sentiment === 'POSITIVE' ? 'safe' : result.analysis.overall.sentiment.sentiment === 'NEGATIVE' ? 'danger' : ''}">
          <div class="finding-title">Overall Sentiment: ${result.analysis.overall.sentiment.sentiment}</div>
          ${result.analysis.overall.sentiment.sentimentScore ? `
            <ul class="entity-list">
              <li class="entity-item">Positive: ${(result.analysis.overall.sentiment.sentimentScore.Positive * 100).toFixed(1)}%</li>
              <li class="entity-item">Negative: ${(result.analysis.overall.sentiment.sentimentScore.Negative * 100).toFixed(1)}%</li>
              <li class="entity-item">Neutral: ${(result.analysis.overall.sentiment.sentimentScore.Neutral * 100).toFixed(1)}%</li>
              <li class="entity-item">Mixed: ${(result.analysis.overall.sentiment.sentimentScore.Mixed * 100).toFixed(1)}%</li>
            </ul>
          ` : ''}
        </div>
      </div>

      <!-- PII Detection -->
      <div class="section">
        <h2>Personal Information (PII) Detection</h2>
        ${result.analysis.overall.pii.hasPII ? `
          <div class="finding danger">
            <div class="finding-title">⚠️ PII Detected (${result.analysis.overall.pii.entityCount} entities)</div>
            <p><strong>Types Found:</strong></p>
            <ul class="entity-list">
              ${Object.entries(result.analysis.overall.pii.entityTypes).map(([type, count]) => 
                `<li class="entity-item">${type}: ${count} occurrence(s)</li>`
              ).join('')}
            </ul>
            <p style="margin-top: 1rem;"><strong>Source Breakdown:</strong></p>
            <ul class="entity-list">
              <li class="entity-item">Audio: ${result.analysis.summary.audioIssues.pii} entities</li>
              <li class="entity-item">Screen: ${result.analysis.summary.screenIssues.pii} entities</li>
            </ul>
          </div>
        ` : `
          <div class="finding safe">
            <div class="finding-title">✓ No PII Detected</div>
            <p>No personal information was found in the content.</p>
          </div>
        `}
      </div>

      <!-- Video Text Detection -->
      <div class="section">
        <h2>Video Text Detection</h2>
        ${result.videoTextData ? `
          <div class="finding safe">
            <div class="finding-title">✓ Text Extraction Successful</div>
            <ul class="entity-list">
              <li class="entity-item">Unique text segments: ${result.videoTextData.segmentCount}</li>
              <li class="entity-item">Total detections: ${result.videoTextData.detectionCount}</li>
            </ul>
          </div>
        ` : `
          <div class="finding">
            <div class="finding-title">⚠️ Video Text Detection Unavailable</div>
            <p>${result.warnings.length > 0 ? result.warnings[0] : 'Video text detection was not performed or failed.'}</p>
          </div>
        `}
      </div>

      <!-- Approval Section -->
      <div class="section">
        <h2>Approval Status</h2>
        <div class="approval-section">
          <div class="approval-status">PENDING REVIEW</div>
          <p style="margin-top: 1rem; color: #6b7280;">
            This content is awaiting manual review by an administrator.
          </p>
        </div>
      </div>
    </div>

    <div class="footer">
      <p>Content Scanner Report • Generated by AWS Lambda</p>
      <p>Scan ID: ${result.scanId}</p>
    </div>
  </div>
</body>
</html>`;
}
