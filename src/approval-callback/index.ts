import { Logger } from '@aws-lambda-powertools/logger';
import { DynamoDBClient, GetItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { 
  LambdaClient, 
  SendDurableExecutionCallbackSuccessCommand 
} from '@aws-sdk/client-lambda';

const logger = new Logger({ serviceName: 'approval-callback' });
const ddb = new DynamoDBClient({});
const lambda = new LambdaClient({});

const CALLBACK_TOKEN_TABLE = process.env.CALLBACK_TOKEN_TABLE!;

interface ApprovalEvent {
  scanId: string;
  approved: boolean;
  reviewedBy: string;
  comments?: string;
}

export const handler = async (event: ApprovalEvent) => {
  logger.info('Approval callback invoked', { event });

  const { scanId, approved, reviewedBy, comments } = event;

  try {
    // Retrieve callback token from DynamoDB
    const jobName = `approval-${scanId}`;
    
    logger.info('Retrieving callback token', { jobName, scanId });
    
    const getResponse = await ddb.send(new GetItemCommand({
      TableName: CALLBACK_TOKEN_TABLE,
      Key: {
        jobName: { S: jobName }
      }
    }));

    if (!getResponse.Item) {
      logger.error('Callback token not found', { jobName, scanId });
      throw new Error(`Callback token not found for scan ${scanId}`);
    }

    const item = unmarshall(getResponse.Item);
    const callbackToken = item.callbackToken;

    logger.info('Callback token retrieved', { jobName, scanId });

    // Send approval result back to durable execution
    const approvalResult = {
      approved,
      reviewedBy,
      reviewedAt: new Date().toISOString(),
      comments: comments || ''
    };

    const command = new SendDurableExecutionCallbackSuccessCommand({
      CallbackId: callbackToken,
      Result: JSON.stringify(approvalResult)
    });

    await lambda.send(command);

    logger.info('Approval result sent to durable execution', { 
      scanId,
      approved,
      reviewedBy
    });

    // Delete callback token from DynamoDB
    await ddb.send(new DeleteItemCommand({
      TableName: CALLBACK_TOKEN_TABLE,
      Key: {
        jobName: { S: jobName }
      }
    }));

    logger.info('Callback token deleted', { jobName });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Approval processed successfully',
        scanId,
        approved
      })
    };
  } catch (error) {
    logger.error('Failed to process approval', {
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : 'Unknown',
      scanId
    });
    throw error;
  }
};
