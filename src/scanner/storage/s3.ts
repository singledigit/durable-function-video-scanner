import { PutObjectCommand } from '@aws-sdk/client-s3';
import { logger, s3 } from '../config';
import { StorageError } from '../errors';

export async function saveReportsToS3(
  bucketName: string,
  scanId: string,
  completeResult: Record<string, unknown>
): Promise<{ jsonReportKey: string }> {
  logger.info('Saving scan results to S3');
  
  try {
    // Save full JSON report to S3
    const jsonReportKey = `reports/${scanId}.json`;
    await s3.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: jsonReportKey,
      Body: JSON.stringify(completeResult, null, 2),
      ContentType: 'application/json'
    }));
    
    logger.info('JSON report saved to S3', { jsonReportKey });
    
    return { jsonReportKey };
  } catch (error) {
    logger.error('Failed to save reports to S3', {
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : 'Unknown',
      bucketName,
      scanId
    });
    
    throw new StorageError(
      'Failed to save reports to S3',
      'write',
      `s3://${bucketName}/reports/${scanId}`,
      error instanceof Error ? error : undefined
    );
  }
}
