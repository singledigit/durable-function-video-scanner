import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

const logger = new Logger({ serviceName: 'list-pending' });
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const TABLE_NAME = process.env.TABLE_NAME!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
  };

  try {
    const groups = event.requestContext.authorizer?.claims?.['cognito:groups'];
    const isAdmin = groups?.includes('Admins');
    
    logger.info('List pending request', { 
      groups, 
      isAdmin,
      claims: event.requestContext.authorizer?.claims 
    });

    if (!isAdmin) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: 'Admin access required' }),
      };
    }

    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI2',
        KeyConditionExpression: 'GSI2PK = :pk',
        ExpressionAttributeValues: {
          ':pk': 'STATUS#PENDING_REVIEW',
        },
        ScanIndexForward: false, // Most recent first
      })
    );

    logger.info('Listed pending reviews', { count: result.Items?.length });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ scans: result.Items || [] }),
    };
  } catch (error) {
    logger.error('Error listing pending reviews', { error });
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
