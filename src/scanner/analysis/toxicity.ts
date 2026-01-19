import { DetectToxicContentCommand } from '@aws-sdk/client-comprehend';
import { logger, comprehend, ToxicityResult } from '../config';

export async function analyzeToxicity(text: string): Promise<ToxicityResult> {
  logger.info('Checking toxicity', { textLength: text.length });
  
  if (!text || text.trim().length === 0) {
    logger.warn('No text to analyze for toxicity');
    return {
      hasToxicContent: false,
      message: 'No text content to analyze'
    };
  }
  
  // Comprehend has a 100KB limit per request
  const MAX_BYTES = 100000;
  const textBytes = Buffer.byteLength(text, 'utf8');
  
  if (textBytes > MAX_BYTES) {
    // For large texts, chunk and analyze
    logger.info('Text exceeds 100KB, chunking for analysis', { textBytes });
    
    const chunks: string[] = [];
    let currentChunk = '';
    const words = text.split(/\s+/);
    
    for (const word of words) {
      const testChunk = currentChunk + (currentChunk ? ' ' : '') + word;
      if (Buffer.byteLength(testChunk, 'utf8') > MAX_BYTES) {
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = word;
      } else {
        currentChunk = testChunk;
      }
    }
    if (currentChunk) chunks.push(currentChunk);
    
    logger.info('Analyzing chunks', { chunkCount: chunks.length });
    
    // Analyze each chunk
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
    
    // Aggregate results - take max score for each label type
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
    
    const hasToxicContent = labels.some(label => label.Score > 0.5);
    
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
    // Single request for smaller texts
    const response = await comprehend.send(new DetectToxicContentCommand({
      TextSegments: [{ Text: text }],
      LanguageCode: 'en'
    }));
    
    const labels = response.ResultList?.[0]?.Labels || [];
    const hasToxicContent = labels.some(label => label.Score! > 0.5);
    
    logger.info('Toxicity analysis completed', { 
      hasToxicContent,
      labelCount: labels.length
    });
    
    return {
      hasToxicContent,
      labels,
      chunked: false
    };
  }
}
