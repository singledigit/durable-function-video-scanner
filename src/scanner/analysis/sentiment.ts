import { DetectSentimentCommand } from '@aws-sdk/client-comprehend';
import { logger, comprehend, SentimentResult } from '../config';
import { AnalysisError } from '../errors';
import { prepareTextForAnalysis } from './utils';

export async function analyzeSentiment(text: string): Promise<SentimentResult> {
  logger.info('Analyzing sentiment', { textLength: text.length });
  
  if (!text || text.trim().length === 0) {
    logger.warn('No text to analyze for sentiment');
    return {
      sentiment: 'NEUTRAL',
      message: 'No text content to analyze'
    };
  }
  
  // Comprehend sentiment has a 5KB limit
  const MAX_BYTES = 5000;
  const prepared = prepareTextForAnalysis(text, MAX_BYTES);
  
  try {
    const response = await comprehend.send(new DetectSentimentCommand({
      Text: prepared.text,
      LanguageCode: 'en'
    }));
    
    logger.info('Sentiment analysis completed', { 
      sentiment: response.Sentiment,
      truncated: prepared.truncated
    });
    
    return {
      sentiment: response.Sentiment!,
      sentimentScore: response.SentimentScore ? {
        Positive: response.SentimentScore.Positive ?? 0,
        Negative: response.SentimentScore.Negative ?? 0,
        Neutral: response.SentimentScore.Neutral ?? 0,
        Mixed: response.SentimentScore.Mixed ?? 0
      } : undefined,
      truncated: prepared.truncated,
      analyzedBytes: prepared.analyzedBytes
    };
  } catch (error) {
    logger.error('Sentiment analysis failed', {
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : 'Unknown'
    });
    
    throw new AnalysisError(
      'Failed to analyze sentiment',
      'sentiment',
      error instanceof Error ? error : undefined
    );
  }
}
