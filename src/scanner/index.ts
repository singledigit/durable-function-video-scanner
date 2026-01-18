import { withDurableExecution, DurableContext } from '@aws/durable-execution-sdk-js';
import { Logger } from '@aws-lambda-powertools/logger';
import { TranscribeClient, StartTranscriptionJobCommand } from '@aws-sdk/client-transcribe';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

const logger = new Logger({ serviceName: 'scanner' });
const transcribe = new TranscribeClient({});
const ddb = new DynamoDBClient({});

const CALLBACK_TOKEN_TABLE = process.env.CALLBACK_TOKEN_TABLE!;

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

  // Start transcription and wait for callback
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

  // Finalize
  logger.info('Transcription completed', { 
    transcriptionResult,
    objectKey,
    objectSize
  });

  const result = {
    transcriptionResult,
    objectKey,
    objectSize,
    status: 'completed'
  };

  logger.info('Scanner completed', { result });

  return result;
});
