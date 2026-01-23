import { logger, TranscriptData, VideoTextData, CorpusData, PiiResult, MappedResults, MappedPIIEntity } from '../config';

export function buildCorpus(
  transcriptData: TranscriptData,
  videoTextData: VideoTextData | null
): CorpusData {
  logger.info('Building corpus', { hasVideoText: !!videoTextData });
  
  // Build position index for mapping offsets back to source
  const positionIndex: Array<{
    startOffset: number;
    endOffset: number;
    source: 'audio' | 'screen';
    timestamp?: number;
    boundingBox?: unknown;
    text: string;
  }> = [];
  
  let currentOffset = 0;
  
  // Add transcript words with timestamps
  const transcriptItems = transcriptData.transcript?.results?.items || [];
  for (const item of transcriptItems) {
    if (item.type === 'pronunciation' && item.alternatives?.[0]?.content) {
      const word = item.alternatives[0].content;
      const startTime = parseFloat(item.start_time || '0');
      
      positionIndex.push({
        startOffset: currentOffset,
        endOffset: currentOffset + word.length,
        source: 'audio',
        timestamp: startTime,
        text: word
      });
      
      currentOffset += word.length + 1; // +1 for space
    }
  }
  
  // Add video text segments with timestamps (if available)
  if (videoTextData) {
    for (const segment of videoTextData.textSegments) {
      positionIndex.push({
        startOffset: currentOffset,
        endOffset: currentOffset + segment.text.length,
        source: 'screen',
        timestamp: segment.timestamp,
        boundingBox: segment.boundingBox,
        text: segment.text
      });
      
      currentOffset += segment.text.length + 1; // +1 for space
    }
  }
  
  // Combine all text
  const combinedText = positionIndex.map(p => p.text).join(' ');
  
  logger.info('Corpus built', {
    totalLength: combinedText.length,
    audioSegments: positionIndex.filter(p => p.source === 'audio').length,
    screenSegments: positionIndex.filter(p => p.source === 'screen').length
  });
  
  return {
    combinedText,
    positionIndex
  };
}

export function mapResultsToSources(
  piiResults: PiiResult,
  positionIndex: CorpusData['positionIndex'],
  combinedText: string
): MappedResults {
  logger.info('Mapping results to sources');
  
  // Helper function to map character offset to source
  const mapOffsetToSource = (offset: number) => {
    for (const pos of positionIndex) {
      if (offset >= pos.startOffset && offset < pos.endOffset) {
        return {
          source: pos.source,
          timestamp: pos.timestamp,
          boundingBox: pos.boundingBox,
          text: pos.text
        };
      }
    }
    return null;
  };
  
  // Map PII entities to sources
  const mappedPII: MappedPIIEntity[] = piiResults.entities.map((entity) => {
    const sourceInfo = mapOffsetToSource(entity.beginOffset);
    return {
      ...entity,
      source: sourceInfo?.source || 'unknown',
      timestamp: sourceInfo?.timestamp,
      boundingBox: sourceInfo?.boundingBox,
      detectedText: sourceInfo?.text || combinedText.substring(entity.beginOffset, entity.endOffset)
    };
  });
  
  // Group by source
  const audioIssues = {
    pii: mappedPII.filter((e) => e.source === 'audio').length
  };
  
  const screenIssues = {
    pii: mappedPII.filter((e) => e.source === 'screen').length
  };
  
  logger.info('Source mapping completed', {
    audioIssues,
    screenIssues
  });
  
  return {
    pii: mappedPII,
    summary: {
      audioIssues,
      screenIssues
    }
  };
}
