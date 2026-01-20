import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Logger } from '@aws-lambda-powertools/logger';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const logger = new Logger({ serviceName: 'upload-handler' });
const s3 = new S3Client({});
const BUCKET_NAME = process.env.BUCKET_NAME!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const userId = event.requestContext.authorizer?.claims?.sub;
    if (!userId) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    const body = JSON.parse(event.body || '{}');
    const { filename, contentType } = body;

    if (!filename) {
      return {
        statusCode: 400,
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

    logger.info('Generated presigned URL', { userId, key });

    return {
      statusCode: 200,
      body: JSON.stringify({ url, key }),
    };
  } catch (error) {
    logger.error('Error generating presigned URL', { error });
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
