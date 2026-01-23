import { DurableContext } from '@aws/durable-execution-sdk-js';
import { StartTextDetectionCommand, GetTextDetectionCommand } from '@aws-sdk/client-rekognition';
import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { 
  logger, 
  rekognition, 
  ddb,
  SCANNER_TABLE,
  REKOGNITION_ROLE_ARN,
  REKOGNITION_SNS_TOPIC_ARN,
  CALLBACK_TIMEOUT_SECONDS,
  CALLBACK_RETRY_STRATEGY,
  VideoTextData
} from '../config';

export async function runRekognitionWorkflow(
  context: DurableContext,
  bucketName: string,
  objectKey: string,
  scanId: string
): Promise<{ videoTextData: VideoTextData | null; error: string | null }> {
  try {
    // Step 3: Start Rekognition and wait for callback
    const rekognitionResult = await context.waitForCallback<string>(
      'rekognition-result',
      async (callbackToken: string) => {
        const jobName = `rekognition-${Date.now()}-${scanId}_${objectKey.replace(/[^a-zA-Z0-9-_]/g, '_')}`;
        
        logger.info('Starting Rekognition text detection job', { jobName, objectKey, scanId });
        
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
      },
      {
        timeout: { seconds: CALLBACK_TIMEOUT_SECONDS },
        retryStrategy: CALLBACK_RETRY_STRATEGY
      }
    );

    // Step 4: Fetch Rekognition results and extract video text
    const videoTextData = await context.step('fetch-video-text', async () => {
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
      const textDetections: unknown[] = [];
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
        boundingBox?: unknown;
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
