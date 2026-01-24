/**
 * Custom error types for better error handling and debugging
 */

export class TranscriptionError extends Error {
  constructor(
    message: string,
    public readonly jobName: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

export class RekognitionError extends Error {
  constructor(
    message: string,
    public readonly jobId?: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'RekognitionError';
  }
}

export class AnalysisError extends Error {
  constructor(
    message: string,
    public readonly analysisType: 'toxicity' | 'sentiment' | 'pii',
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'AnalysisError';
  }
}

export class BedrockError extends Error {
  constructor(
    message: string,
    public readonly modelId: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'BedrockError';
  }
}

export class StorageError extends Error {
  constructor(
    message: string,
    public readonly operation: 'read' | 'write' | 'delete',
    public readonly resource: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/**
 * Retry configuration for different error types
 */
export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2
};

/**
 * Determines if an error is retryable
 */
export function isRetryableError(error: Error): boolean {
  const retryableErrorCodes = [
    'ThrottlingException',
    'TooManyRequestsException',
    'ServiceUnavailable',
    'InternalServerError',
    'RequestTimeout',
    'ProvisionedThroughputExceededException',
    'RequestLimitExceeded'
  ];

  const errorName = error.name;
  const errorMessage = error.message;

  // Check if error name matches retryable codes
  if (retryableErrorCodes.some(code => errorName.includes(code))) {
    return true;
  }

  // Check if error message contains retryable indicators
  if (
    errorMessage.includes('throttl') ||
    errorMessage.includes('rate limit') ||
    errorMessage.includes('too many requests') ||
    errorMessage.includes('service unavailable') ||
    errorMessage.includes('timeout')
  ) {
    return true;
  }

  return false;
}

/**
 * Executes a function with exponential backoff retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  logger?: { warn: (...args: unknown[]) => void }
): Promise<T> {
  let lastError: Error;
  let delay = config.initialDelayMs;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry if error is not retryable
      if (!isRetryableError(lastError)) {
        throw lastError;
      }

      // Don't retry on last attempt
      if (attempt === config.maxAttempts) {
        throw lastError;
      }

      // Log retry attempt
      logger?.warn('Retrying after error', {
        attempt,
        maxAttempts: config.maxAttempts,
        error: lastError.message,
        errorName: lastError.name,
        delayMs: delay
      });

      // Wait before retrying
      await sleep(delay);

      // Calculate next delay with exponential backoff
      delay = Math.min(delay * config.backoffMultiplier, config.maxDelayMs);
    }
  }

  throw lastError!;
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wraps an async function to catch and transform errors
 */
export function catchAndTransform<T>(
  fn: () => Promise<T>,
  errorTransformer: (error: Error) => Error
): Promise<T> {
  return fn().catch(error => {
    const originalError = error instanceof Error ? error : new Error(String(error));
    throw errorTransformer(originalError);
  });
}
