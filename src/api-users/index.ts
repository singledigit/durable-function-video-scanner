import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, AdminCreateUserCommand, ListUsersCommand, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const cognito = new CognitoIdentityProviderClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const USER_POOL_ID = process.env.USER_POOL_ID!;
const APPSYNC_EVENTS_API_URL = process.env.APPSYNC_EVENTS_API_URL!;
const AWS_REGION = process.env.AWS_REGION || 'us-west-2';

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  body?: string;
  pathParameters?: { [key: string]: string };
  requestContext?: {
    authorizer?: {
      claims?: {
        sub: string;
      };
    };
  };
}

export const handler = async (event: APIGatewayEvent) => {
  const method = event.httpMethod;
  const path = event.path;

  try {
    // GET /profile - Get user profile
    if (method === 'GET' && path === '/profile') {
      const userId = event.requestContext?.authorizer?.claims?.sub;
      if (!userId) {
        return {
          statusCode: 401,
          headers,
          body: JSON.stringify({ error: 'Unauthorized' })
        };
      }

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

    // PUT /profile - Update user profile
    if (method === 'PUT' && path === '/profile') {
      const userId = event.requestContext?.authorizer?.claims?.sub;
      if (!userId) {
        return {
          statusCode: 401,
          headers,
          body: JSON.stringify({ error: 'Unauthorized' })
        };
      }

      const body = JSON.parse(event.body || '{}');
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

    // POST /admin/users/invite - Invite new user
    if (method === 'POST' && path.includes('/invite')) {
      const { email } = JSON.parse(event.body || '{}');

      const result = await cognito.send(new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' }
        ],
        DesiredDeliveryMediums: ['EMAIL']
      }));

      // Create the user's channel by publishing an initial event
      const userId = result.User?.Username;
      if (userId && APPSYNC_EVENTS_API_URL) {
        try {
          const url = new URL(APPSYNC_EVENTS_API_URL);
          const channel = `default/scan-updates-${userId}`;
          
          const body = JSON.stringify({
            channel,
            events: [{
              type: 'CHANNEL_CREATED',
              userId,
              timestamp: new Date().toISOString()
            }]
          });

          const request = new HttpRequest({
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'host': url.hostname,
            },
            body,
          });

          const signer = new SignatureV4({
            service: 'appsync',
            region: AWS_REGION,
            credentials: defaultProvider(),
            sha256: Sha256,
          });

          const signedRequest = await signer.sign(request);
          await fetch(`https://${signedRequest.hostname}${signedRequest.path}`, {
            method: signedRequest.method,
            headers: signedRequest.headers as Record<string, string>,
            body: signedRequest.body,
          });

          console.log(`Created channel for user: ${userId}`);
        } catch (error) {
          console.error('Failed to create channel:', error);
          // Don't fail the user creation if channel creation fails
        }
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true })
      };
    }

    // GET /admin/users - List all users
    if (method === 'GET' && path.includes('/admin/users')) {
      const result = await cognito.send(new ListUsersCommand({
        UserPoolId: USER_POOL_ID
      }));

      const users = result.Users?.map(u => ({
        username: u.Username,
        email: u.Attributes?.find(a => a.Name === 'email')?.Value,
        status: u.UserStatus
      })) || [];

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(users)
      };
    }

    // DELETE /admin/users/{username} - Delete user
    if (method === 'DELETE' && path.includes('/admin/users/')) {
      const username = event.pathParameters?.username;
      if (!username) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Username required' })
        };
      }

      await cognito.send(new AdminDeleteUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: username
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
  } catch (error: unknown) {
    console.error('API error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error instanceof Error ? error.message : 'Internal server error' })
    };
  }
};
