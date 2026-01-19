import { Logger } from '@aws-lambda-powertools/logger';
import { 
  LambdaClient, 
  SendDurableExecutionCallbackSuccessCommand,
  SendDurableExecutionCallbackFailureCommand 
} from '@aws-sdk/client-lambda';
import { DynamoDBClient, GetItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const logger = new Logger({ serviceName: 'rekognition-callback' });
const lambda = new LambdaClient({});
const ddb = new DynamoDBClient({});

const CALLBACK_TOKEN_TABLE = process.env.CALLBACK_TOKEN_TABLE!;

interface SNSEvent {
  Records: Array<{
    Sns: {
      Message: string;
      MessageAttributes?: Record<string, any>;
    };
  }>;
}

interface RekognitionMessage {
  JobId: string;
  Status: string;
  API: string;
  JobTag?: string;
  Timestamp?: number;
  Message?: string;
  ErrorCode?: string;
  Video?: {
    S3ObjectName?: string;
    S3Bucket?: string;
  };
}

export const handler = async (event: SNSEvent) => {
  logger.info('SNS event received', { event });

  // Process each SNS record
  for (const record of event.Records) {
    const message: RekognitionMessage = JSON.parse(record.Sns.Message);
    
    logger.info('Rekognition message parsed', { message });

    const jobId = message.JobId;
    const status = message.Status;
    const jobTag = message.JobTag;
    
    if (!jobTag) {
      logger.error('No JobTag found in Rekognition message', { jobId });
      continue;
    }
    
    // Get the callback token from DynamoDB using JobTag as jobName
    const getResult = await ddb.send(new GetItemCommand({
      TableName: CALLBACK_TOKEN_TABLE,
      Key: marshall({ jobName: jobTag })
    }));

    const item = getResult.Item ? unmarshall(getResult.Item) : null;
    const callbackToken = item?.callbackToken;

    if (!callbackToken) {
      logger.error('No callback token found in DynamoDB', { jobTag, jobId });
      continue;
    }

    logger.info('Found callback token', { jobTag, jobId, status });

    // Send callback to durable execution
    const callbackData = {
      status,
      jobId,
      jobTag
    };

    try {
      if (status === 'FAILED' || status === 'ERROR') {
        // Extract error details from message if available
        const errorMessage = message.Message || `Rekognition text detection job failed with status: ${status}`;
        const errorCode = message.ErrorCode || 'RekognitionFailed';
        
        const command = new SendDurableExecutionCallbackFailureCommand({
          CallbackId: callbackToken,
          ErrorType: errorCode,
          ErrorMessage: errorMessage,
          ErrorData: JSON.stringify({
            jobId,
            jobTag,
            status
          })
        });
        
        await lambda.send(command);
        logger.info('Failure callback sent', { jobTag, jobId, errorCode, errorMessage });
      } else if (status === 'SUCCEEDED') {
        const command = new SendDurableExecutionCallbackSuccessCommand({
          CallbackId: callbackToken,
          Result: JSON.stringify(callbackData)
        });
        
        await lambda.send(command);
        logger.info('Success callback sent', { jobTag, jobId });
      } else {
        logger.warn('Unexpected Rekognition status', { status, jobId, jobTag });
        continue;
      }

      // Clean up the token from DynamoDB after successful callback
      await ddb.send(new DeleteItemCommand({
        TableName: CALLBACK_TOKEN_TABLE,
        Key: marshall({ jobName: jobTag })
      }));
      
      logger.info('Callback token cleaned up from DynamoDB', { jobTag });
    } catch (error) {
      logger.error('Failed to send callback', {
        jobTag,
        jobId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  return { success: true };
};
