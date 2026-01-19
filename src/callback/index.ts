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

const SCANNER_TABLE = process.env.SCANNER_TABLE!;

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
      
      // Extract scanId from jobName (format: rekognition-timestamp-scanId_...)
      const scanIdMatch = jobName.match(/rekognition-\d+-(.+)/);
      const scanId = scanIdMatch ? scanIdMatch[1].split('_')[0] : null;
      
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
      
      logger.info('Rekognition event detected', { jobName, jobId, status, scanId });
    }
    // Direct invoke (Approval)
    else if ('scanId' in event) {
      const scanId = event.scanId;
      jobName = `approval-${scanId}`;
      
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

    // Get callback token from DynamoDB using single table design
    // For approval events, we know the scanId directly
    // For job events, we need to extract scanId from jobName or query by jobName
    let getResult;
    
    if (jobName.startsWith('approval-')) {
      // Direct lookup for approval tokens
      const scanId = jobName.replace('approval-', '');
      getResult = await ddb.send(new GetItemCommand({
        TableName: SCANNER_TABLE,
        Key: marshall({ 
          PK: `SCAN#${scanId}`,
          SK: 'TOKEN#approval'
        })
      }));
    } else {
      // For transcribe/rekognition, we need to find the token by jobName
      // This requires a query since jobName is not in the key
      // For now, extract scanId from jobName pattern
      let scanId: string | null = null;
      
      if (jobName.startsWith('transcribe-')) {
        // Format: transcribe-timestamp-scanId_...
        const match = jobName.match(/transcribe-\d+-(.+)/);
        scanId = match ? match[1].split('_')[0] : null;
      } else if (jobName.startsWith('rekognition-')) {
        // Format: rekognition-timestamp-scanId_...
        const match = jobName.match(/rekognition-\d+-(.+)/);
        scanId = match ? match[1].split('_')[0] : null;
      }
      
      if (!scanId) {
        throw new Error(`Could not extract scanId from jobName: ${jobName}`);
      }
      
      const tokenSK = jobName.startsWith('transcribe-') ? `TOKEN#${jobName}` : `TOKEN#${jobName}`;
      
      getResult = await ddb.send(new GetItemCommand({
        TableName: SCANNER_TABLE,
        Key: marshall({ 
          PK: `SCAN#${scanId}`,
          SK: tokenSK
        })
      }));
    }

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
    if (jobName.startsWith('approval-')) {
      const scanId = jobName.replace('approval-', '');
      await ddb.send(new DeleteItemCommand({
        TableName: SCANNER_TABLE,
        Key: marshall({ 
          PK: `SCAN#${scanId}`,
          SK: 'TOKEN#approval'
        })
      }));
    } else {
      // Extract scanId for transcribe/rekognition tokens
      let scanId: string | null = null;
      
      if (jobName.startsWith('transcribe-')) {
        const match = jobName.match(/transcribe-\d+-(.+)/);
        scanId = match ? match[1].split('_')[0] : null;
      } else if (jobName.startsWith('rekognition-')) {
        const match = jobName.match(/rekognition-\d+-(.+)/);
        scanId = match ? match[1].split('_')[0] : null;
      }
      
      if (scanId) {
        const tokenSK = `TOKEN#${jobName}`;
        await ddb.send(new DeleteItemCommand({
          TableName: SCANNER_TABLE,
          Key: marshall({ 
            PK: `SCAN#${scanId}`,
            SK: tokenSK
          })
        }));
      }
    }
    
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
