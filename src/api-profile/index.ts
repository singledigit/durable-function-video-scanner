import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME!;

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS'
};

export const handler = async (event: { requestContext: { authorizer: { claims: { sub: string } } }; httpMethod: string; body?: string }) => {
  const userId = event.requestContext.authorizer.claims.sub;
  const method = event.httpMethod;

  try {
    if (method === 'GET') {
      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `USER#${userId}`, SK: 'PROFILE' }
      }));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(result.Item || {})
      };
    }

    if (method === 'PUT') {
      const body = JSON.parse(event.body);
      const { firstName, lastName, displayName } = body;

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: `USER#${userId}`,
          SK: 'PROFILE',
          firstName,
          lastName,
          displayName,
          updatedAt: new Date().toISOString()
        }
      }));

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true })
      };
    }

    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  } catch (error) {
    console.error('Profile error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
