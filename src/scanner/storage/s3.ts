import { PutObjectCommand } from '@aws-sdk/client-s3';
import { logger, s3 } from '../config';
import { generateHtmlReport } from '../reporting/html-generator';
import { withRetry, StorageError } from '../errors';

export async function saveReportsToS3(
  bucketName: string,
  scanId: string,
  completeResult: any
): Promise<{ jsonReportKey: string; htmlReportKey: string }> {
  logger.info('Saving scan results to S3');
  
  try {
    // Save full JSON report to S3
    const jsonReportKey = `reports/${scanId}.json`;
    await withRetry(
      async () => s3.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: jsonReportKey,
        Body: JSON.stringify(completeResult, null, 2),
        ContentType: 'application/json'
      })),
      undefined,
      logger
    );
    
    logger.info('JSON report saved to S3', { jsonReportKey });
    
    // Generate HTML report
    const htmlReport = generateHtmlReport(completeResult);
    const htmlReportKey = `reports/${scanId}.html`;
    
    await withRetry(
      async () => s3.send(new PutObjectCommand({
        Bucket: bucketName,
        Key: htmlReportKey,
        Body: htmlReport,
        ContentType: 'text/html'
      })),
      undefined,
      logger
    );
    
    logger.info('HTML report saved to S3', { htmlReportKey });
    
    return { jsonReportKey, htmlReportKey };
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
