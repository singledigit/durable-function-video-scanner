import { CognitoIdentityProviderClient, AdminCreateUserCommand, ListUsersCommand, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

const cognito = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.USER_POOL_ID!;
const APPSYNC_EVENTS_API_URL = process.env.APPSYNC_EVENTS_API_URL!;
const AWS_REGION = process.env.AWS_REGION || 'us-west-2';

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'
};

export const handler = async (event: any) => {
  const method = event.httpMethod;
  const path = event.path;

  try {
    // POST /admin/users/invite - Invite new user
    if (method === 'POST' && path.includes('/invite')) {
      const { email } = JSON.parse(event.body);

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
    if (method === 'GET') {
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
    if (method === 'DELETE') {
      const username = event.pathParameters?.username;

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
  } catch (error: any) {
    console.error('User management error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || 'Internal server error' })
    };
  }
};
