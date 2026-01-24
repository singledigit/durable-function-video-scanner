import { DurableContext } from '@aws/durable-execution-sdk-js';
import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { marshall } from '@aws-sdk/util-dynamodb';
import { logger, ddb, s3, SCANNER_TABLE, TIMEOUTS, CALLBACK_RETRY_STRATEGY, ToxicityResult, PiiResult, SentimentResult } from '../config';
import { StorageError } from '../errors';

// ============================================
// CALLBACK TOKENS
// ============================================

/**
 * Stores a callback token in DynamoDB for durable function workflows
 */
export async function storeCallbackToken(
  scanId: string,
  jobName: string,
  callbackToken: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await ddb.send(new PutItemCommand({
    TableName: SCANNER_TABLE,
    Item: marshall({
      PK: `SCAN#${scanId}`,
      SK: `TOKEN#${jobName}`,
      EntityType: 'CallbackToken',
      jobName,
      callbackToken,
      ...metadata,
      createdAt: new Date().toISOString(),
      ttl: Math.floor(Date.now() / 1000) + TIMEOUTS.TOKEN_TTL_SECONDS
    })
  }));
}

// ============================================
// S3 OPERATIONS
// ============================================

export async function saveReportsToS3(
  bucketName: string,
  scanId: string,
  completeResult: Record<string, unknown>
): Promise<{ jsonReportKey: string }> {
  logger.info('Saving scan results to S3');
  
  try {
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

// ============================================
// DYNAMODB OPERATIONS
// ============================================

async function putItem(item: Record<string, unknown>): Promise<void> {
  await ddb.send(new PutItemCommand({
    TableName: SCANNER_TABLE,
    Item: marshall(item, { removeUndefinedValues: true })
  }));
}

async function putItemWithErrorHandling(
  item: Record<string, unknown>,
  errorContext: { operation: string; scanId: string; userId?: string }
): Promise<void> {
  try {
    await putItem(item);
    
    logger.info(`${errorContext.operation} saved to DynamoDB`, { 
      scanId: errorContext.scanId,
      userId: errorContext.userId 
    });
  } catch (error) {
    logger.error(`Failed to ${errorContext.operation.toLowerCase()}`, {
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : 'Unknown',
      scanId: errorContext.scanId,
      userId: errorContext.userId
    });
    
    throw new StorageError(
      `Failed to ${errorContext.operation.toLowerCase()}`,
      'write',
      `dynamodb://${SCANNER_TABLE}/SCAN#${errorContext.scanId}`,
      error instanceof Error ? error : undefined
    );
  }
}

export async function saveScanMetadata(
  scanId: string,
  userId: string,
  objectKey: string,
  bucketName: string,
  uploadedAt: string,
  objectSize: number,
  overallAssessment: 'SAFE' | 'CAUTION' | 'UNSAFE',
  status: string,
  toxicityResults: ToxicityResult,
  piiResults: PiiResult,
  sentimentResults: SentimentResult,
  aiSummary: { summary: string; modelId?: string; generatedAt: string; error?: string },
  jsonReportKey: string
): Promise<void> {
  logger.info('Saving scan metadata to DynamoDB', { scanId, userId });
  
  const completedAt = new Date().toISOString();
  
  await putItemWithErrorHandling(
    {
      PK: `SCAN#${scanId}`,
      SK: 'METADATA',
      EntityType: 'ScanResult',
      GSI1PK: `USER#${userId}`,
      GSI1SK: uploadedAt,
      GSI2PK: 'STATUS#PENDING_REVIEW',
      GSI2SK: uploadedAt,
      scanId,
      userId,
      objectKey,
      bucketName,
      status,
      approvalStatus: 'PENDING_REVIEW',
      uploadedAt,
      completedAt,
      fileSize: objectSize,
      overallAssessment,
      hasToxicContent: toxicityResults.hasToxicContent,
      hasPII: piiResults.hasPII,
      sentiment: sentimentResults.sentiment,
      aiSummary: aiSummary.summary,
      reportS3Key: jsonReportKey
    },
    {
      operation: 'Scan metadata',
      scanId,
      userId
    }
  );
}

export async function waitForApproval(
  context: DurableContext,
  scanId: string,
  userId: string,
  bucketName: string,
  objectKey: string
): Promise<{
  approved: boolean;
  reviewedBy: string;
  reviewedAt: string;
  comments?: string;
}> {
  try {
    const approvalResult = await context.waitForCallback<{
      approved: boolean;
      reviewedBy: string;
      reviewedAt: string;
      comments?: string;
    }>(
      'human-approval',
      async (callbackToken: string) => {
        logger.info('Waiting for human approval', { scanId, callbackToken });
        
        await putItem({
          PK: `SCAN#${scanId}`,
          SK: 'TOKEN#approval',
          EntityType: 'CallbackToken',
          jobName: `approval-${scanId}`,
          callbackToken,
          scanId,
          userId,
          bucketName,
          objectKey,
          createdAt: new Date().toISOString(),
          ttl: Math.floor(Date.now() / 1000) + TIMEOUTS.APPROVAL_TOKEN_TTL_SECONDS
        });
        
        logger.info('Approval callback token stored', { 
          scanId,
          expiresIn: '3 days'
        });
      },
      {
        timeout: { seconds: TIMEOUTS.APPROVAL_SECONDS },
        retryStrategy: CALLBACK_RETRY_STRATEGY
      }
    );
    
    const parsedResult = typeof approvalResult === 'string' 
      ? JSON.parse(approvalResult) 
      : approvalResult;
    
    return parsedResult;
  } catch (error) {
    logger.warn('Approval timeout - auto-rejecting', {
      scanId,
      error: error instanceof Error ? error.message : String(error)
    });
    
    return {
      approved: false,
      reviewedBy: 'system',
      reviewedAt: new Date().toISOString(),
      comments: 'Auto-rejected due to 3-day approval timeout'
    };
  }
}

export async function updateApprovalStatus(
  scanId: string,
  userId: string,
  uploadedAt: string,
  objectKey: string,
  bucketName: string,
  objectSize: number,
  overallAssessment: 'SAFE' | 'CAUTION' | 'UNSAFE',
  status: string,
  toxicityResults: ToxicityResult,
  piiResults: PiiResult,
  sentimentResults: SentimentResult,
  aiSummary: { summary: string; modelId?: string; generatedAt: string; error?: string },
  jsonReportKey: string,
  approvalResult: {
    approved: boolean;
    reviewedBy: string;
    reviewedAt: string;
    comments?: string;
  }
): Promise<{
  approvalStatus: string;
  reviewedBy: string;
  reviewedAt: string;
  comments?: string;
}> {
  logger.info('Updating approval status', { 
    scanId,
    approved: approvalResult.approved 
  });
  
  const finalApprovalStatus = approvalResult.approved ? 'APPROVED' : 'REJECTED';
  const completedAt = new Date().toISOString();
  
  await putItem({
    PK: `SCAN#${scanId}`,
    SK: 'METADATA',
    EntityType: 'ScanResult',
    GSI1PK: `USER#${userId}`,
    GSI1SK: uploadedAt,
    GSI2PK: `STATUS#${finalApprovalStatus}`,
    GSI2SK: uploadedAt,
    scanId,
    userId,
    objectKey,
    bucketName,
    status,
    approvalStatus: finalApprovalStatus,
    uploadedAt,
    completedAt,
    reviewedAt: approvalResult.reviewedAt,
    reviewedBy: approvalResult.reviewedBy,
    reviewComments: approvalResult.comments || '',
    fileSize: objectSize,
    overallAssessment,
    hasToxicContent: toxicityResults.hasToxicContent,
    hasPII: piiResults.hasPII,
    sentiment: sentimentResults.sentiment,
    aiSummary: aiSummary.summary,
    reportS3Key: jsonReportKey
  });
  
  logger.info('Approval status updated in DynamoDB', { 
    scanId,
    finalApprovalStatus 
  });
  
  return {
    approvalStatus: finalApprovalStatus,
    reviewedBy: approvalResult.reviewedBy,
    reviewedAt: approvalResult.reviewedAt,
    comments: approvalResult.comments
  };
}
