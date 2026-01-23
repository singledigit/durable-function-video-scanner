import { DurableContext } from '@aws/durable-execution-sdk-js';
import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { logger, ddb, SCANNER_TABLE, CALLBACK_RETRY_STRATEGY } from '../config';
import { withRetry, StorageError } from '../errors';

export async function saveScanMetadata(
  scanId: string,
  userId: string,
  objectKey: string,
  bucketName: string,
  uploadedAt: string,
  objectSize: number,
  overallAssessment: 'SAFE' | 'CAUTION' | 'UNSAFE',
  status: string,
  toxicityResults: any,
  piiResults: any,
  sentimentResults: any,
  aiSummary: any,
  jsonReportKey: string
): Promise<void> {
  logger.info('Saving scan metadata to DynamoDB', { scanId, userId });
  
  const completedAt = new Date().toISOString();
  
  try {
    await withRetry(
      async () => ddb.send(new PutItemCommand({
        TableName: SCANNER_TABLE,
        Item: marshall({
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
        }, { removeUndefinedValues: true })
      })),
      undefined,
      logger
    );
    
    logger.info('Scan metadata saved to DynamoDB', { scanId, userId });
  } catch (error) {
    logger.error('Failed to save scan metadata to DynamoDB', {
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : 'Unknown',
      scanId,
      userId
    });
    
    throw new StorageError(
      'Failed to save scan metadata',
      'write',
      `dynamodb://${SCANNER_TABLE}/SCAN#${scanId}`,
      error instanceof Error ? error : undefined
    );
  }
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
        
        // Store callback token in DynamoDB for approval workflow
        await ddb.send(new PutItemCommand({
          TableName: SCANNER_TABLE,
          Item: marshall({
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
            ttl: Math.floor(Date.now() / 1000) + (3 * 86400) // 3 days TTL
          })
        }));
        
        logger.info('Approval callback token stored', { 
          scanId,
          expiresIn: '3 days'
        });
      },
      {
        timeout: { seconds: 259200 }, // 3 days = 259200 seconds
        retryStrategy: CALLBACK_RETRY_STRATEGY
      }
    );
    
    // Parse if result is a string (durable SDK returns stringified result)
    const parsedResult = typeof approvalResult === 'string' 
      ? JSON.parse(approvalResult) 
      : approvalResult;
    
    return parsedResult;
  } catch (error) {
    // Handle timeout - auto-reject after 3 days
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
  toxicityResults: any,
  piiResults: any,
  sentimentResults: any,
  aiSummary: any,
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
  
  // Update DynamoDB with final approval status
  await ddb.send(new PutItemCommand({
    TableName: SCANNER_TABLE,
    Item: marshall({
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
    }, { removeUndefinedValues: true })
  }));
  
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
