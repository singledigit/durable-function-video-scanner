import { Logger } from '@aws-lambda-powertools/logger';
import { TranscribeClient } from '@aws-sdk/client-transcribe';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { ComprehendClient } from '@aws-sdk/client-comprehend';
import { RekognitionClient } from '@aws-sdk/client-rekognition';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

// ============================================================================
// Logger
// ============================================================================
export const logger = new Logger({ serviceName: 'scanner' });

// ============================================================================
// AWS Service Clients
// ============================================================================
export const transcribe = new TranscribeClient({});
export const ddb = new DynamoDBClient({});
export const s3 = new S3Client({});
export const comprehend = new ComprehendClient({});
export const rekognition = new RekognitionClient({});
export const bedrock = new BedrockRuntimeClient({});

// ============================================================================
// Environment Variables
// ============================================================================

// Core
export const SCANNER_TABLE = process.env.SCANNER_TABLE!;
export const AWS_REGION = process.env.AWS_REGION || 'us-west-2';

// Rekognition
export const REKOGNITION_ROLE_ARN = process.env.REKOGNITION_ROLE_ARN!;
export const REKOGNITION_SNS_TOPIC_ARN = process.env.REKOGNITION_SNS_TOPIC_ARN!;

// Bedrock
export const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'global.amazon.nova-2-lite-v1:0';

// AppSync Events
export const APPSYNC_EVENTS_API_URL = process.env.APPSYNC_EVENTS_API_URL!;

// ============================================================================
// Durable Function Configuration
// ============================================================================

// Retry Strategy
// Development: No retries for fast failure during development/debugging
export const CALLBACK_RETRY_STRATEGY = () => ({ shouldRetry: false });

// Production: Exponential backoff retry strategy for transient failures
// Retries up to 3 times with exponential backoff (2s, 4s, 8s)
// export const CALLBACK_RETRY_STRATEGY = (attempt: number) => ({
//   shouldRetry: attempt < 3,
//   delayInSeconds: Math.pow(2, attempt) // 2^1=2s, 2^2=4s, 2^3=8s
// });

// Timeouts (in seconds)
export const TIMEOUTS = {
  CALLBACK_SECONDS: 1800,                 // 30 minutes for AWS service callbacks
  APPROVAL_SECONDS: 259200,               // 3 days for human approval
  TOKEN_TTL_SECONDS: 86400,               // 24 hours for callback tokens
  APPROVAL_TOKEN_TTL_SECONDS: 259200      // 3 days for approval tokens
} as const;

// ============================================================================
// AWS Service Configuration
// ============================================================================

// Service Limits (in bytes)
export const SERVICE_LIMITS = {
  COMPREHEND_TOXICITY_MAX_BYTES: 100000,  // 100KB
  COMPREHEND_SENTIMENT_MAX_BYTES: 5000,   // 5KB
  COMPREHEND_PII_MAX_BYTES: 100000        // 100KB
} as const;

// Analysis Thresholds
export const THRESHOLDS = {
  REKOGNITION_CONFIDENCE_MIN: 80,         // Minimum confidence % for text detection
  TOXICITY_SCORE_THRESHOLD: 0.5           // Score above this is considered toxic
} as const;

// ============================================================================
// Type Definitions
// ============================================================================

export interface S3Event {
  detail: {
    bucket: {
      name: string;
    };
    object: {
      key: string;
      size: number;
    };
  };
}

export interface ToxicityResult {
  hasToxicContent: boolean;
  labels?: Array<{ Name: string; Score: number }>;
  chunked?: boolean;
  chunkCount?: number;
  message?: string;
}

export interface SentimentResult {
  sentiment: string;
  sentimentScore?: {
    Positive: number;
    Negative: number;
    Neutral: number;
    Mixed: number;
  };
  truncated?: boolean;
  analyzedBytes?: number;
  message?: string;
}

export interface PiiResult {
  hasPII: boolean;
  entityCount: number;
  entityTypes: Record<string, number>;
  entities: Array<{
    type: string;
    score: number;
    beginOffset: number;
    endOffset: number;
  }>;
  truncated?: boolean;
  analyzedBytes?: number;
  message?: string;
}

export interface TranscriptData {
  fullText: string;
  transcriptUri: string;
  transcript: unknown;
  transcriptionResult: string;
}

export interface VideoTextData {
  fullText: string;
  textSegments: Array<{
    text: string;
    timestamp: number;
    confidence: number;
    boundingBox?: unknown;
  }>;
  detectionCount: number;
}

export interface CorpusData {
  combinedText: string;
  positionIndex: Array<{
    startOffset: number;
    endOffset: number;
    source: 'audio' | 'screen';
    timestamp?: number;
    boundingBox?: unknown;
    text: string;
  }>;
}

export interface MappedPIIEntity {
  type: string;
  score: number;
  beginOffset: number;
  endOffset: number;
  source: string;
  timestamp?: number;
  boundingBox?: unknown;
  detectedText: string;
}

export interface MappedResults {
  pii: MappedPIIEntity[];
  summary: {
    audioIssues: {
      pii: number;
    };
    screenIssues: {
      pii: number;
    };
  };
}

export interface ToxicityLabel {
  Name: string;
  Score: number;
}
