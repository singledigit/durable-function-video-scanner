import { DetectToxicContentCommand, DetectSentimentCommand, DetectPiiEntitiesCommand } from '@aws-sdk/client-comprehend';
import { logger, comprehend, SERVICE_LIMITS, THRESHOLDS, ToxicityResult, SentimentResult, PiiResult } from '../config';
import { AnalysisError } from '../errors';
import { chunkTextByBytes, prepareTextForAnalysis } from './utils';

// ============================================
// TOXICITY DETECTION
// ============================================

export async function analyzeToxicity(text: string): Promise<ToxicityResult> {
  logger.info('Checking toxicity', { textLength: text.length });
  
  if (!text || text.trim().length === 0) {
    logger.warn('No text to analyze for toxicity');
    return {
      hasToxicContent: false,
      message: 'No text content to analyze'
    };
  }
  
  const textBytes = Buffer.byteLength(text, 'utf8');
  
  if (textBytes > SERVICE_LIMITS.COMPREHEND_TOXICITY_MAX_BYTES) {
    logger.info('Text exceeds 100KB, chunking for analysis', { textBytes });
    
    const chunks = chunkTextByBytes(text, SERVICE_LIMITS.COMPREHEND_TOXICITY_MAX_BYTES);
    
    logger.info('Analyzing chunks', { chunkCount: chunks.length });
    
    const chunkResults = await Promise.all(
      chunks.map(async (chunk, index) => {
        const response = await comprehend.send(new DetectToxicContentCommand({
          TextSegments: [{ Text: chunk }],
          LanguageCode: 'en'
        }));
        
        return {
          chunkIndex: index,
          labels: response.ResultList?.[0]?.Labels || []
        };
      })
    );
    
    const aggregatedLabels = new Map<string, number>();
    
    for (const result of chunkResults) {
      for (const label of result.labels) {
        const name = label.Name!;
        const score = label.Score!;
        const currentMax = aggregatedLabels.get(name) || 0;
        aggregatedLabels.set(name, Math.max(currentMax, score));
      }
    }
    
    const labels = Array.from(aggregatedLabels.entries()).map(([name, score]) => ({
      Name: name,
      Score: score
    }));
    
    const hasToxicContent = labels.some(label => label.Score > THRESHOLDS.TOXICITY_SCORE_THRESHOLD);
    
    logger.info('Toxicity analysis completed (chunked)', { 
      hasToxicContent,
      labelCount: labels.length,
      chunkCount: chunks.length
    });
    
    return {
      hasToxicContent,
      labels,
      chunked: true,
      chunkCount: chunks.length
    };
  } else {
    try {
      const response = await comprehend.send(new DetectToxicContentCommand({
        TextSegments: [{ Text: text }],
        LanguageCode: 'en'
      }));
      
      const rawLabels = response.ResultList?.[0]?.Labels || [];
      const labels = rawLabels.map(label => ({
        Name: label.Name!,
        Score: label.Score!
      }));
      const hasToxicContent = labels.some(label => label.Score > THRESHOLDS.TOXICITY_SCORE_THRESHOLD);
      
      logger.info('Toxicity analysis completed', { 
        hasToxicContent,
        labelCount: labels.length
      });
      
      return {
        hasToxicContent,
        labels,
        chunked: false
      };
    } catch (error) {
      logger.error('Toxicity analysis failed', {
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : 'Unknown'
      });
      
      throw new AnalysisError(
        'Failed to analyze toxicity',
        'toxicity',
        error instanceof Error ? error : undefined
      );
    }
  }
}

// ============================================
// SENTIMENT ANALYSIS
// ============================================

export async function analyzeSentiment(text: string): Promise<SentimentResult> {
  logger.info('Analyzing sentiment', { textLength: text.length });
  
  if (!text || text.trim().length === 0) {
    logger.warn('No text to analyze for sentiment');
    return {
      sentiment: 'NEUTRAL',
      message: 'No text content to analyze'
    };
  }
  
  const prepared = prepareTextForAnalysis(text, SERVICE_LIMITS.COMPREHEND_SENTIMENT_MAX_BYTES);
  
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

// ============================================
// PII DETECTION
// ============================================

export async function detectPII(text: string): Promise<PiiResult> {
  logger.info('Detecting PII', { textLength: text.length });
  
  if (!text || text.trim().length === 0) {
    logger.warn('No text to analyze for PII');
    return {
      hasPII: false,
      entityCount: 0,
      entityTypes: {},
      entities: [],
      message: 'No text content to analyze'
    };
  }
  
  const prepared = prepareTextForAnalysis(text, SERVICE_LIMITS.COMPREHEND_PII_MAX_BYTES);
  
  try {
    const response = await comprehend.send(new DetectPiiEntitiesCommand({
      Text: prepared.text,
      LanguageCode: 'en'
    }));
    
    const entities = response.Entities || [];
    const hasPII = entities.length > 0;
    
    const entityTypes = entities.reduce((acc, entity) => {
      const type = entity.Type!;
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    logger.info('PII detection completed', { 
      hasPII,
      entityCount: entities.length,
      entityTypes: Object.keys(entityTypes),
      truncated: prepared.truncated
    });
    
    return {
      hasPII,
      entityCount: entities.length,
      entityTypes,
      entities: entities.map(e => ({
        type: e.Type!,
        score: e.Score!,
        beginOffset: e.BeginOffset!,
        endOffset: e.EndOffset!
      })),
      truncated: prepared.truncated,
      analyzedBytes: prepared.analyzedBytes
    };
  } catch (error) {
    logger.error('PII detection failed', {
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : 'Unknown'
    });
    
    throw new AnalysisError(
      'Failed to detect PII',
      'pii',
      error instanceof Error ? error : undefined
    );
  }
}
