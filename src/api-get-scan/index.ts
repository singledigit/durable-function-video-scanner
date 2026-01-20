import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const logger = new Logger({ serviceName: 'get-scan' });
const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const s3 = new S3Client({});
const TABLE_NAME = process.env.TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const userId = event.requestContext.authorizer?.claims?.sub;
    const scanId = event.pathParameters?.scanId;

    if (!userId || !scanId) {
      return {
        statusCode: 400,
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
        body: JSON.stringify({ error: 'Scan not found' }),
      };
    }

    // Verify user owns this scan
    if (result.Item.userId !== userId) {
      return {
        statusCode: 403,
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
      body: JSON.stringify({
        scan: result.Item,
        fullReport,
      }),
    };
  } catch (error) {
    logger.error('Error retrieving scan', { error });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
