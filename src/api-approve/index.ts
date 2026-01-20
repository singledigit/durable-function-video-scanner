import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const logger = new Logger({ serviceName: 'approve' });
const lambda = new LambdaClient({});
const CALLBACK_FUNCTION_NAME = process.env.CALLBACK_FUNCTION_NAME!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const groups = event.requestContext.authorizer?.claims?.['cognito:groups'];
    const isAdmin = groups?.includes('Admins');

    if (!isAdmin) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Admin access required' }),
      };
    }

    const body = JSON.parse(event.body || '{}');
    const { scanId, approved, comments } = body;
    const reviewedBy = event.requestContext.authorizer?.claims?.email || 'unknown';

    if (!scanId || approved === undefined) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'scanId and approved are required' }),
      };
    }

    // Invoke callback function with approval decision
    await lambda.send(
      new InvokeCommand({
        FunctionName: CALLBACK_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: JSON.stringify({
          scanId,
          approved,
          reviewedBy,
          comments: comments || '',
        }),
      })
    );

    logger.info('Approval decision submitted', { scanId, approved, reviewedBy });

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Approval decision submitted' }),
    };
  } catch (error) {
    logger.error('Error submitting approval', { error });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
