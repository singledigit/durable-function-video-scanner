import { DetectSentimentCommand } from '@aws-sdk/client-comprehend';
import { logger, comprehend, SentimentResult } from '../config';

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
  const textBytes = Buffer.byteLength(text, 'utf8');
  
  // If text is too large, analyze first 5KB
  const textToAnalyze = textBytes > MAX_BYTES 
    ? text.substring(0, Math.floor(text.length * (MAX_BYTES / textBytes)))
    : text;
  
  const response = await comprehend.send(new DetectSentimentCommand({
    Text: textToAnalyze,
    LanguageCode: 'en'
  }));
  
  logger.info('Sentiment analysis completed', { 
    sentiment: response.Sentiment,
    truncated: textBytes > MAX_BYTES
  });
  
  return {
    sentiment: response.Sentiment!,
    sentimentScore: response.SentimentScore,
    truncated: textBytes > MAX_BYTES,
    analyzedBytes: Buffer.byteLength(textToAnalyze, 'utf8')
  };
}
