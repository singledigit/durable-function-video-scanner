import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { corsHeaders } from './cors';

const s3 = new S3Client({});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: ''
    };
  }

  try {
    const { objectKey } = JSON.parse(event.body || '{}');
    
    if (!objectKey) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'objectKey is required' })
      };
    }

    const bucketName = process.env.BUCKET_NAME!;
    
    // Generate presigned URL valid for 1 hour
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: objectKey
    });
    
    const url = await getSignedUrl(s3, command, { expiresIn: 3600 });

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ url })
    };
  } catch (error) {
    console.error('Failed to generate presigned URL:', error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to generate video URL' })
    };
  }
};
