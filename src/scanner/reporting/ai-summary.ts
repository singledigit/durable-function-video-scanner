import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { logger, bedrock, BEDROCK_MODEL_ID, ToxicityResult, SentimentResult, PiiResult, VideoTextData } from '../config';

export async function generateAISummary(
  toxicityResults: ToxicityResult,
  sentimentResults: SentimentResult,
  piiResults: PiiResult,
  videoTextData: VideoTextData | null,
  mappedResults: any,
  objectKey: string,
  objectSize: number
): Promise<{ summary: string; modelId?: string; generatedAt: string; error?: string }> {
  logger.info('Generating AI summary with Nova Lite');
  
  try {
    // Build structured prompt with analysis results
    const prompt = `You are a content moderation assistant. Analyze the following content scan results and provide a concise summary.

VIDEO FILE: ${objectKey}
FILE SIZE: ${(objectSize / 1024 / 1024).toFixed(2)} MB

ANALYSIS RESULTS:

1. TOXICITY DETECTION:
${toxicityResults.hasToxicContent ? 
  `⚠️ TOXIC CONTENT DETECTED
${(toxicityResults.labels || []).map((l: any) => `   - ${l.Name}: ${(l.Score * 100).toFixed(1)}%`).join('\n')}` :
  '✓ No toxic content detected'}

2. SENTIMENT ANALYSIS:
   Overall Sentiment: ${sentimentResults.sentiment}
${sentimentResults.sentimentScore ? 
  `   Confidence Scores:
   - Positive: ${(sentimentResults.sentimentScore.Positive * 100).toFixed(1)}%
   - Negative: ${(sentimentResults.sentimentScore.Negative * 100).toFixed(1)}%
   - Neutral: ${(sentimentResults.sentimentScore.Neutral * 100).toFixed(1)}%
   - Mixed: ${(sentimentResults.sentimentScore.Mixed * 100).toFixed(1)}%` : ''}

3. PII DETECTION:
${piiResults.hasPII ?
  `⚠️ PII DETECTED (${piiResults.entityCount} entities)
   Types found: ${Object.entries(piiResults.entityTypes).map(([type, count]) => `${type} (${count})`).join(', ')}
   
   Source Breakdown:
   - Audio: ${mappedResults.summary.audioIssues.pii} PII entities
   - Screen: ${mappedResults.summary.screenIssues.pii} PII entities` :
  '✓ No PII detected'}

4. VIDEO TEXT DETECTION:
${videoTextData ? 
  `✓ Successfully extracted text from video
   - Unique text segments: ${videoTextData.textSegments.length}
   - Total detections: ${videoTextData.detectionCount}` :
  `⚠️ Video text detection failed or unavailable`}

TASK:
Provide a 3-4 sentence executive summary that:
1. States the overall content safety assessment (Safe/Caution/Unsafe)
2. Highlights the most critical findings
3. Provides a clear recommendation for content moderation action

Keep it concise and actionable.`;

    const requestBody = {
      messages: [
        {
          role: 'user',
          content: [{ text: prompt }]
        }
      ],
      inferenceConfig: {
        maxTokens: 500,
        temperature: 0.3,
        topP: 0.9
      }
    };

    const command = new InvokeModelCommand({
      modelId: BEDROCK_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(requestBody)
    });

    const response = await bedrock.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    
    const summaryText = responseBody.output?.message?.content?.[0]?.text || 'Summary generation failed';
    
    logger.info('AI summary generated successfully', { 
      summaryLength: summaryText.length,
      modelId: BEDROCK_MODEL_ID
    });

    return {
      summary: summaryText,
      modelId: BEDROCK_MODEL_ID,
      generatedAt: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Failed to generate AI summary', {
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : 'Unknown'
    });
    
    return {
      summary: 'AI summary generation failed. Please review raw analysis results.',
      error: error instanceof Error ? error.message : String(error),
      generatedAt: new Date().toISOString()
    };
  }
}
