import { DurableContext } from '@aws/durable-execution-sdk-js';
import { StartTranscriptionJobCommand, GetTranscriptionJobCommand } from '@aws-sdk/client-transcribe';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { 
  logger, 
  transcribe, 
  s3,
  CALLBACK_TIMEOUT_SECONDS,
  CALLBACK_RETRY_STRATEGY,
  TranscriptData
} from '../config';
import { storeCallbackToken } from '../storage/callback-tokens';

export async function runTranscribeWorkflow(
  context: DurableContext,
  bucketName: string,
  objectKey: string,
  scanId: string
): Promise<TranscriptData> {
  // Step 1: Start transcription and wait for callback
  const transcriptionResult = await context.waitForCallback<string>(
    'transcription-result',
    async (callbackToken: string) => {
      const jobName = `transcribe-${Date.now()}-${scanId}_${objectKey.replace(/[^a-zA-Z0-9-_]/g, '_')}`;
      
      logger.info('Starting transcription job', { jobName, objectKey, scanId });
      
      // Store callback token in DynamoDB
      await storeCallbackToken(scanId, jobName, callbackToken, {
        bucketName,
        objectKey
      });
      
      logger.info('Callback token stored in DynamoDB', { jobName });
      
      const command = new StartTranscriptionJobCommand({
        TranscriptionJobName: jobName,
        LanguageCode: 'en-US',
        MediaFormat: 'mp4',
        Media: {
          MediaFileUri: `s3://${bucketName}/${objectKey}`
        },
        OutputBucketName: bucketName,
        OutputKey: `transcripts/${objectKey}.json`,
        Tags: [
          { Key: 'SourceBucket', Value: bucketName },
          { Key: 'SourceKey', Value: objectKey }
        ]
      });
      
      const response = await transcribe.send(command);
      
      logger.info('Transcription job started successfully', { 
        jobName, 
        status: response.TranscriptionJob?.TranscriptionJobStatus 
      });
    },
    {
      timeout: { seconds: CALLBACK_TIMEOUT_SECONDS },
      retryStrategy: CALLBACK_RETRY_STRATEGY
    }
  );

  // Step 2: Fetch transcript from S3
  const transcriptData = await context.step('fetch-transcript', async () => {
    logger.info('Processing transcription callback result', { transcriptionResult });
    
    const parsedResult = typeof transcriptionResult === 'string' 
      ? JSON.parse(transcriptionResult) 
      : transcriptionResult;
    
    // Fetch full transcription job details
    const jobDetails = await transcribe.send(new GetTranscriptionJobCommand({
      TranscriptionJobName: parsedResult.jobName
    }));
    
    const transcriptUri = jobDetails.TranscriptionJob?.Transcript?.TranscriptFileUri;
    
    if (!transcriptUri) {
      throw new Error('No transcript URI found in transcription job details');
    }
    
    logger.info('Fetching transcript from S3', { transcriptUri });
    
    let bucket: string;
    let key: string;
    
    // Parse S3 URI - can be s3://bucket/key or https://s3.region.amazonaws.com/bucket/key
    const s3UriMatch = transcriptUri.match(/s3:\/\/([^\/]+)\/(.+)/);
    const httpsUriMatch = transcriptUri.match(/https:\/\/s3[.-]([^.]+)\.amazonaws\.com\/([^\/]+)\/(.+)/);
    
    if (s3UriMatch) {
      [, bucket, key] = s3UriMatch;
    } else if (httpsUriMatch) {
      bucket = httpsUriMatch[2];
      key = httpsUriMatch[3];
    } else {
      throw new Error(`Invalid S3 URI format: ${transcriptUri}`);
    }
    
    logger.info('Fetching transcript file', { bucket, key });
    
    const response = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: key
    }));
    
    const transcriptJson = await response.Body?.transformToString();
    if (!transcriptJson) {
      throw new Error('Empty transcript file');
    }
    
    const transcript = JSON.parse(transcriptJson);
    const fullText = transcript.results?.transcripts?.[0]?.transcript || '';
    
    logger.info('Transcript fetched successfully', { 
      textLength: fullText.length,
      bucket,
      key
    });
    
    return {
      fullText,
      transcriptUri,
      transcript,
      transcriptionResult
    };
  });

  return transcriptData;
}
