import { PutObjectCommand } from '@aws-sdk/client-s3';
import { logger, s3 } from '../config';
import { generateHtmlReport } from '../reporting/html-generator';

export async function saveReportsToS3(
  bucketName: string,
  scanId: string,
  completeResult: any
): Promise<{ jsonReportKey: string; htmlReportKey: string }> {
  logger.info('Saving scan results to S3');
  
  // Save full JSON report to S3
  const jsonReportKey = `reports/${scanId}.json`;
  await s3.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: jsonReportKey,
    Body: JSON.stringify(completeResult, null, 2),
    ContentType: 'application/json'
  }));
  
  logger.info('JSON report saved to S3', { jsonReportKey });
  
  // Generate HTML report
  const htmlReport = generateHtmlReport(completeResult);
  const htmlReportKey = `reports/${scanId}.html`;
  
  await s3.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: htmlReportKey,
    Body: htmlReport,
    ContentType: 'text/html'
  }));
  
  logger.info('HTML report saved to S3', { htmlReportKey });
  
  return { jsonReportKey, htmlReportKey };
}
