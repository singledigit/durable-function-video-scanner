import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const logger = new Logger({ serviceName: 'api-scans' });
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3 = new S3Client({});

const TABLE_NAME = process.env.TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

/**
 * Main handler - routes requests to appropriate handler based on path and method
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  const path = event.path;
  const method = event.httpMethod;

  try {
    // GET /scans - List user's scans
    if (method === 'GET' && path === '/scans') {
      return await listScans(event);
    }

    // GET /scans/{scanId} - Get single scan
    if (method === 'GET' && path.match(/^\/scans\/[^/]+$/)) {
      return await getScan(event);
    }

    // GET /admin/scans/pending - List pending reviews (admin only)
    if (method === 'GET' && path === '/admin/scans/pending') {
      return await listPendingScans(event);
    }

    // POST /scans/upload - Generate upload presigned URL
    if (method === 'POST' && path === '/scans/upload') {
      return await generateUploadUrl(event);
    }

    // POST /scans/{scanId}/video-url - Generate video presigned URL
    if (method === 'POST' && path.match(/^\/scans\/[^/]+\/video-url$/)) {
      return await generateVideoUrl(event);
    }

    // Route not found
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Route not found' }),
    };
  } catch (error) {
    logger.error('Unhandled error', { error, path, method });
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};

/**
 * GET /scans - List user's scans
 */
async function listScans(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const userId = event.requestContext.authorizer?.claims?.sub;
  
  if (!userId) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `USER#${userId}`,
      },
      ScanIndexForward: false, // Most recent first
    })
  );

  logger.info('Listed scans', { userId, count: result.Items?.length });

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ scans: result.Items || [] }),
  };
}

/**
 * GET /scans/{scanId} - Get single scan with full report
 */
async function getScan(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const userId = event.requestContext.authorizer?.claims?.sub;
  const groups = event.requestContext.authorizer?.claims?.['cognito:groups'];
  const isAdmin = groups?.includes('Admins');
  const scanId = event.pathParameters?.scanId;

  if (!userId || !scanId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Missing required parameters' }),
    };
  }

  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `SCAN#${scanId}`,
        SK: 'METADATA',
      },
    })
  );

  if (!result.Item) {
    return {
      statusCode: 404,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Scan not found' }),
    };
  }

  // Verify user owns this scan or is admin
  if (result.Item.userId !== userId && !isAdmin) {
    return {
      statusCode: 403,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Forbidden' }),
    };
  }

  // Fetch full report from S3 if available
  let fullReport = null;
  if (result.Item.reportS3Key) {
    try {
      const reportResponse = await s3.send(
        new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: result.Item.reportS3Key,
        })
      );
      const reportBody = await reportResponse.Body?.transformToString();
      fullReport = reportBody ? JSON.parse(reportBody) : null;
    } catch (error) {
      logger.warn('Could not fetch full report', { error });
    }
  }

  logger.info('Retrieved scan', { userId, scanId });

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      scan: result.Item,
      fullReport,
    }),
  };
}

/**
 * GET /admin/scans/pending - List pending reviews (admin only)
 */
async function listPendingScans(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const groups = event.requestContext.authorizer?.claims?.['cognito:groups'];
  const isAdmin = groups?.includes('Admins');

  logger.info('List pending request', { groups, isAdmin });

  if (!isAdmin) {
    return {
      statusCode: 403,
      headers: CORS_HEADERS,
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
    headers: CORS_HEADERS,
    body: JSON.stringify({ scans: result.Items || [] }),
  };
}

/**
 * POST /scans/upload - Generate presigned URL for video upload
 */
async function generateUploadUrl(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const userId = event.requestContext.authorizer?.claims?.sub;
  
  if (!userId) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  const body = JSON.parse(event.body || '{}');
  const { filename, contentType } = body;

  if (!filename) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'filename is required' }),
    };
  }

  const key = `raw/${userId}/${Date.now()}-${filename}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ContentType: contentType || 'video/mp4',
  });

  const url = await getSignedUrl(s3, command, { expiresIn: 3600 });

  logger.info('Generated upload presigned URL', { userId, key });

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ url, key }),
  };
}

/**
 * POST /scans/{scanId}/video-url - Generate presigned URL for video playback
 */
async function generateVideoUrl(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const userId = event.requestContext.authorizer?.claims?.sub;
  
  if (!userId) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  const body = JSON.parse(event.body || '{}');
  const { objectKey } = body;

  if (!objectKey) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'objectKey is required' }),
    };
  }

  // Generate presigned URL valid for 1 hour
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: objectKey,
  });

  const url = await getSignedUrl(s3, command, { expiresIn: 3600 });

  logger.info('Generated video presigned URL', { userId, objectKey });

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ url }),
  };
}
