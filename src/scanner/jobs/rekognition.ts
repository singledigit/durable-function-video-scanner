import { DurableContext } from '@aws/durable-execution-sdk-js';
import { StartTextDetectionCommand, GetTextDetectionCommand } from '@aws-sdk/client-rekognition';
import { 
  logger, 
  rekognition,
  REKOGNITION_ROLE_ARN,
  REKOGNITION_SNS_TOPIC_ARN,
  TIMEOUTS,
  CALLBACK_RETRY_STRATEGY,
  THRESHOLDS,
  VideoTextData
} from '../config';
import { storeCallbackToken } from '../storage';

export async function runRekognitionWorkflow(
  context: DurableContext,
  bucketName: string,
  objectKey: string,
  scanId: string
): Promise<{ videoTextData: VideoTextData | null; error: string | null }> {
  try {
    const rekognitionResult = await context.waitForCallback<string>(
      'rekognition-result',
      async (callbackToken: string) => {
        const jobName = `rekognition-${Date.now()}-${scanId}_${objectKey.replace(/[^a-zA-Z0-9-_]/g, '_')}`;
        
        logger.info('Starting Rekognition text detection job', { jobName, objectKey, scanId });
        
        await storeCallbackToken(scanId, jobName, callbackToken, {
          bucketName,
          objectKey,
          jobType: 'rekognition'
        });
        
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
        timeout: { seconds: TIMEOUTS.CALLBACK_SECONDS },
        retryStrategy: CALLBACK_RETRY_STRATEGY
      }
    );

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
      
      const textSegments: Array<{
        text: string;
        timestamp: number;
        confidence: number;
        boundingBox?: unknown;
      }> = [];
      
      const seenText = new Map<string, number>();
      
      for (const detection of textDetections) {
        const text = detection.TextDetection?.DetectedText;
        const confidence = detection.TextDetection?.Confidence || 0;
        const timestamp = detection.Timestamp || 0;
        
        if (confidence < THRESHOLDS.REKOGNITION_CONFIDENCE_MIN) continue;
        
        if (text && !seenText.has(text)) {
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
