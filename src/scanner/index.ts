import { withDurableExecution, DurableContext } from '@aws/durable-execution-sdk-js';
import { Logger } from '@aws-lambda-powertools/logger';
import { TranscribeClient, StartTranscriptionJobCommand } from '@aws-sdk/client-transcribe';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { ComprehendClient, DetectToxicContentCommand, DetectSentimentCommand, DetectPiiEntitiesCommand } from '@aws-sdk/client-comprehend';
import { RekognitionClient, StartTextDetectionCommand, GetTextDetectionCommand } from '@aws-sdk/client-rekognition';

const logger = new Logger({ serviceName: 'scanner' });
const transcribe = new TranscribeClient({});
const ddb = new DynamoDBClient({});
const s3 = new S3Client({});
const comprehend = new ComprehendClient({});
const rekognition = new RekognitionClient({});

const CALLBACK_TOKEN_TABLE = process.env.CALLBACK_TOKEN_TABLE!;
const REKOGNITION_ROLE_ARN = process.env.REKOGNITION_ROLE_ARN!;
const REKOGNITION_SNS_TOPIC_ARN = process.env.REKOGNITION_SNS_TOPIC_ARN!;

// Global callback configuration
const CALLBACK_CONFIG = {
  timeoutSeconds: 600, // 10 minutes
  retryStrategy: { maxAttempts: 0 }
};

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

export const handler = withDurableExecution(async (event: S3Event, context: DurableContext) => {
  // logger.info('Scanner function invoked', { event });

  const bucketName = event.detail.bucket.name;
  const objectKey = event.detail.object.key;
  const objectSize = event.detail.object.size;

  try {

  // Step 1: Start transcription and wait for callback
  const transcriptionResult = await context.waitForCallback(
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
    CALLBACK_CONFIG
  );

  // Step 2: Fetch transcript from S3
  const transcriptData = await context.step('fetch-transcript', async () => {
    logger.info('Fetching transcript from S3', { transcriptionResult });
    
    const parsedResult = typeof transcriptionResult === 'string' 
      ? JSON.parse(transcriptionResult) 
      : transcriptionResult;
    
    const transcriptUri = parsedResult.transcriptUri;
    if (!transcriptUri) {
      throw new Error('No transcript URI found in transcription result');
    }
    
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
      transcript
    };
  });

  // Step 3: Start Rekognition text detection and wait for callback (with error handling)
  let videoTextData = null;
  let rekognitionError = null;
  
  try {
    const rekognitionResult = await context.waitForCallback(
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
      CALLBACK_CONFIG
    );

    // Step 4: Fetch Rekognition results and extract video text
    videoTextData = await context.step('fetch-video-text', async () => {
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
  } catch (error) {
    rekognitionError = error instanceof Error ? error.message : String(error);
    logger.warn('Rekognition text detection failed, continuing with audio-only analysis', {
      error: rekognitionError,
      errorName: error instanceof Error ? error.name : 'Unknown',
      objectKey
    });
  }

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
  const toxicityResults = analysisResults.all[0].result;
  const sentimentResults = analysisResults.all[1].result;
  const piiResults = analysisResults.all[2].result;

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

  const result = {
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
    objectKey,
    objectSize,
    status: videoTextData ? 'completed' : 'partial',
    warnings
  };

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
