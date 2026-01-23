/**
 * Shared utilities for text analysis operations
 */

/**
 * Prepares text for analysis by truncating if it exceeds the maximum byte size
 * 
 * @param text - The text to prepare
 * @param maxBytes - Maximum allowed bytes for the analysis service
 * @returns Object containing the prepared text, truncation status, and analyzed byte count
 */
export function prepareTextForAnalysis(
  text: string,
  maxBytes: number
): { text: string; truncated: boolean; analyzedBytes: number } {
  if (!text || text.trim().length === 0) {
    return {
      text: '',
      truncated: false,
      analyzedBytes: 0
    };
  }

  const textBytes = Buffer.byteLength(text, 'utf8');
  const truncated = textBytes > maxBytes;
  
  // If text is too large, truncate proportionally
  const analyzedText = truncated 
    ? text.substring(0, Math.floor(text.length * (maxBytes / textBytes)))
    : text;
  
  return {
    text: analyzedText,
    truncated,
    analyzedBytes: Buffer.byteLength(analyzedText, 'utf8')
  };
}

/**
 * Chunks text into smaller pieces that fit within the byte limit
 * Splits on word boundaries to avoid breaking words
 * 
 * @param text - The text to chunk
 * @param maxBytes - Maximum bytes per chunk
 * @returns Array of text chunks
 */
export function chunkTextByBytes(text: string, maxBytes: number): string[] {
  if (!text || text.trim().length === 0) {
    return [];
  }

  const textBytes = Buffer.byteLength(text, 'utf8');
  
  // If text fits in one chunk, return it
  if (textBytes <= maxBytes) {
    return [text];
  }

  const chunks: string[] = [];
  let currentChunk = '';
  const words = text.split(/\s+/);
  
  for (const word of words) {
    const testChunk = currentChunk + (currentChunk ? ' ' : '') + word;
    if (Buffer.byteLength(testChunk, 'utf8') > maxBytes) {
      if (currentChunk) chunks.push(currentChunk);
      currentChunk = word;
    } else {
      currentChunk = testChunk;
    }
  }
  
  if (currentChunk) chunks.push(currentChunk);
  
  return chunks;
}
