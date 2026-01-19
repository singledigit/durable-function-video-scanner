import { Logger } from '@aws-lambda-powertools/logger';
import { 
  LambdaClient, 
  SendDurableExecutionCallbackSuccessCommand,
  SendDurableExecutionCallbackFailureCommand 
} from '@aws-sdk/client-lambda';
import { DynamoDBClient, GetItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const logger = new Logger({ serviceName: 'callback' });
const lambda = new LambdaClient({});
const ddb = new DynamoDBClient({});

const CALLBACK_TOKEN_TABLE = process.env.CALLBACK_TOKEN_TABLE!;

// Event type detection
interface EventBridgeEvent {
  detail: Record<string, any>;
  'detail-type': string;
}

interface SNSEvent {
  Records: Array<{
    Sns: {
      Message: string;
    };
  }>;
}

interface DirectInvokeEvent {
  [key: string]: any;
}

export const handler = async (event: EventBridgeEvent | SNSEvent | DirectInvokeEvent) => {
  logger.info('Callback handler invoked', { event });

  try {
    // Detect event source and extract job identifier
    let jobName: string;
    let result: any;
    let isFailure = false;
    let errorInfo: { type?: string; message?: string; data?: string } = {};

    // EventBridge events (Transcribe)
    if ('detail-type' in event && event.detail) {
      const detail = event.detail;
      
      if (detail.TranscriptionJobName) {
        // Transcribe event
        jobName = detail.TranscriptionJobName;
        const status = detail.TranscriptionJobStatus;
        
        result = {
          jobName,
          status
        };
        
        if (status === 'FAILED') {
          isFailure = true;
          errorInfo = {
            type: 'TranscriptionFailed',
            message: detail.FailureReason || 'Transcription job failed',
            data: JSON.stringify({ jobName })
          };
        }
        
        logger.info('Transcribe event detected', { jobName, status });
      } else {
        throw new Error('Unknown EventBridge event type');
      }
    }
    // SNS events (Rekognition)
    else if ('Records' in event && Array.isArray(event.Records)) {
      const record = event.Records[0];
      const message = JSON.parse(record.Sns.Message);
      
      jobName = message.JobTag;
      const status = message.Status;
      const jobId = message.JobId;
      
      result = {
        jobName,
        jobId,
        status
      };
      
      if (status === 'FAILED' || status === 'ERROR') {
        isFailure = true;
        errorInfo = {
          type: message.ErrorCode || 'RekognitionFailed',
          message: message.Message || `Rekognition job failed with status: ${status}`,
          data: JSON.stringify({ jobId, jobName, status })
        };
      }
      
      logger.info('Rekognition event detected', { jobName, jobId, status });
    }
    // Direct invoke (Approval)
    else if ('scanId' in event) {
      jobName = `approval-${event.scanId}`;
      
      result = {
        approved: event.approved,
        reviewedBy: event.reviewedBy,
        reviewedAt: new Date().toISOString(),
        comments: event.comments || ''
      };
      
      logger.info('Approval event detected', { scanId: event.scanId, approved: event.approved });
    }
    else {
      throw new Error('Unknown event type');
    }

    // Get callback token from DynamoDB
    const getResult = await ddb.send(new GetItemCommand({
      TableName: CALLBACK_TOKEN_TABLE,
      Key: marshall({ jobName })
    }));

    const item = getResult.Item ? unmarshall(getResult.Item) : null;
    const callbackToken = item?.callbackToken;

    if (!callbackToken) {
      logger.error('No callback token found in DynamoDB', { jobName });
      throw new Error(`Callback token not found for job: ${jobName}`);
    }

    logger.info('Found callback token', { jobName });

    // Send callback to durable execution
    if (isFailure) {
      const command = new SendDurableExecutionCallbackFailureCommand({
        CallbackId: callbackToken,
        ErrorType: errorInfo.type,
        ErrorMessage: errorInfo.message,
        ErrorData: errorInfo.data
      });
      
      await lambda.send(command);
      logger.info('Failure callback sent', { jobName });
    } else {
      const command = new SendDurableExecutionCallbackSuccessCommand({
        CallbackId: callbackToken,
        Result: JSON.stringify(result)
      });
      
      await lambda.send(command);
      logger.info('Success callback sent', { jobName });
    }

    // Clean up the token from DynamoDB
    await ddb.send(new DeleteItemCommand({
      TableName: CALLBACK_TOKEN_TABLE,
      Key: marshall({ jobName })
    }));
    
    logger.info('Callback token cleaned up from DynamoDB', { jobName });

    return { success: true };
  } catch (error) {
    logger.error('Failed to process callback', {
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : 'Unknown'
    });
    throw error;
  }
};
