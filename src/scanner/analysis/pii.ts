import { DetectPiiEntitiesCommand } from '@aws-sdk/client-comprehend';
import { logger, comprehend, PiiResult } from '../config';

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
  const textBytes = Buffer.byteLength(text, 'utf8');
  
  // If text is too large, analyze first 100KB
  const textToAnalyze = textBytes > MAX_BYTES 
    ? text.substring(0, Math.floor(text.length * (MAX_BYTES / textBytes)))
    : text;
  
  const response = await comprehend.send(new DetectPiiEntitiesCommand({
    Text: textToAnalyze,
    LanguageCode: 'en'
  }));
  
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
    truncated: textBytes > MAX_BYTES
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
    truncated: textBytes > MAX_BYTES,
    analyzedBytes: Buffer.byteLength(textToAnalyze, 'utf8')
  };
}
