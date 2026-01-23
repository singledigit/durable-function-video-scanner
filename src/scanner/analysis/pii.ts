import { DetectPiiEntitiesCommand } from '@aws-sdk/client-comprehend';
import { logger, comprehend, PiiResult } from '../config';
import { withRetry, AnalysisError } from '../errors';
import { prepareTextForAnalysis } from './utils';

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
  
  // Comprehend PII has a 100KB limit
  const MAX_BYTES = 100000;
  const prepared = prepareTextForAnalysis(text, MAX_BYTES);
  
  try {
    const response = await withRetry(
      async () => comprehend.send(new DetectPiiEntitiesCommand({
        Text: prepared.text,
        LanguageCode: 'en'
      })),
      undefined,
      logger
    );
    
    const entities = response.Entities || [];
    const hasPII = entities.length > 0;
    
    // Group by type for summary
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
