import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { ddb, SCANNER_TABLE } from '../config';

/**
 * Stores a callback token in DynamoDB for durable function workflows
 * 
 * @param scanId - The scan ID
 * @param jobName - The job name (used as part of the sort key)
 * @param callbackToken - The durable function callback token
 * @param metadata - Additional metadata to store with the token
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
      ttl: Math.floor(Date.now() / 1000) + 86400 // 24 hours TTL
    })
  }));
}
