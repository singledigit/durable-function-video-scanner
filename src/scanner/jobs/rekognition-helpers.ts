import { StartTextDetectionCommand, GetTextDetectionCommand } from '@aws-sdk/client-rekognition';
import { 
  logger, 
  rekognition,
  REKOGNITION_ROLE_ARN,
  REKOGNITION_SNS_TOPIC_ARN,
  THRESHOLDS,
  VideoTextData
} from '../config';
import { storeCallbackToken } from '../storage/callback-tokens';

/**
 * Start a Rekognition text detection job and store the callback token
 * Pure helper - no durable operations
 */
export async function startRekognitionJob(
  bucketName: string,
  objectKey: string,
  scanId: string,
  callbackToken: string
): Promise<string> {
  const jobName = `rekognition-${Date.now()}-${scanId}_${objectKey.replace(/[^a-zA-Z0-9-_]/g, '_')}`;
  
  logger.info('Starting Rekognition text detection job', { jobName, objectKey, scanId });
  
  // Store callback token in DynamoDB
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
  
  return jobName;
}

/**
 * Fetch and process Rekognition text detection results
 * Pure helper - no durable operations
 */
export async function fetchVideoTextResults(
  rekognitionResult: string
): Promise<VideoTextData> {
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
    if (confidence < THRESHOLDS.REKOGNITION_CONFIDENCE_MIN) continue;
    
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
}
