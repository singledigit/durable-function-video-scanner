import { Logger } from '@aws-lambda-powertools/logger';
import { 
  LambdaClient, 
  SendDurableExecutionCallbackSuccessCommand,
  SendDurableExecutionCallbackFailureCommand 
} from '@aws-sdk/client-lambda';
import { DynamoDBClient, GetItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { TranscribeClient, GetTranscriptionJobCommand } from '@aws-sdk/client-transcribe';

const logger = new Logger({ serviceName: 'transcribe-callback' });
const lambda = new LambdaClient({});
const ddb = new DynamoDBClient({});
const transcribe = new TranscribeClient({});

const CALLBACK_TOKEN_TABLE = process.env.CALLBACK_TOKEN_TABLE!;

interface TranscribeEvent {
  detail: {
    TranscriptionJobName: string;
    TranscriptionJobStatus: string;
    TranscriptionJob?: {
      TranscriptionJobArn?: string;
      Transcript?: {
        TranscriptFileUri?: string;
      };
      FailureReason?: string;
    };
  };
}

export const handler = async (event: TranscribeEvent) => {
  logger.info('Transcribe event received', { event });

  const jobName = event.detail.TranscriptionJobName;
  const status = event.detail.TranscriptionJobStatus;
  
  // Get the callback token from DynamoDB
  const getResult = await ddb.send(new GetItemCommand({
    TableName: CALLBACK_TOKEN_TABLE,
    Key: marshall({ jobName })
  }));

  const item = getResult.Item ? unmarshall(getResult.Item) : null;
  const callbackToken = item?.callbackToken;

  if (!callbackToken) {
    logger.error('No callback token found in DynamoDB', { jobName });
    return;
  }

  logger.info('Found callback token', { jobName, status });

  // Fetch full transcription job details
  const jobDetails = await transcribe.send(new GetTranscriptionJobCommand({
    TranscriptionJobName: jobName
  }));

  const transcriptUri = jobDetails.TranscriptionJob?.Transcript?.TranscriptFileUri;
  const failureReason = jobDetails.TranscriptionJob?.FailureReason;

  logger.info('Fetched transcription job details', { 
    jobName, 
    transcriptUri,
    failureReason 
  });

  // Send callback to durable execution
  const callbackData = {
    status,
    transcriptUri,
    failureReason,
    jobName
  };

  try {
    if (status === 'FAILED') {
      const command = new SendDurableExecutionCallbackFailureCommand({
        CallbackId: callbackToken,
        Error: JSON.stringify({
          error: 'TranscriptionFailed',
          message: failureReason || 'Transcription job failed',
          jobName
        })
      });
      
      await lambda.send(command);
      logger.info('Failure callback sent', { jobName });
    } else {
      const command = new SendDurableExecutionCallbackSuccessCommand({
        CallbackId: callbackToken,
        Result: JSON.stringify(callbackData)
      });
      
      await lambda.send(command);
      logger.info('Success callback sent', { jobName, transcriptUri });
    }

    // Clean up the token from DynamoDB after successful callback
    await ddb.send(new DeleteItemCommand({
      TableName: CALLBACK_TOKEN_TABLE,
      Key: marshall({ jobName })
    }));
    
    logger.info('Callback token cleaned up from DynamoDB', { jobName });
  } catch (error) {
    logger.error('Failed to send callback', {
      jobName,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }

  return { success: true };
};
