import { ToxicityResult, SentimentResult, PiiResult, VideoTextData } from '../config';

interface ReportData {
  scanId: string;
  userId: string;
  objectKey: string;
  bucketName: string;
  uploadedAt: string;
  completedAt: string;
  fileSize: number;
  overallAssessment: 'SAFE' | 'CAUTION' | 'UNSAFE';
  status: string;
  warnings: string[];
  aiSummary: {
    summary: string;
    modelId?: string;
    generatedAt: string;
    error?: string;
  };
  analysis: {
    overall: {
      toxicity: ToxicityResult;
      sentiment: SentimentResult;
      pii: PiiResult & {
        entities: Array<{
          type: string;
          score: number;
          beginOffset: number;
          endOffset: number;
          source?: string;
          timestamp?: number;
          boundingBox?: any;
          detectedText?: string;
        }>;
      };
    };
    summary: {
      audioIssues: { pii: number };
      screenIssues: { pii: number };
    };
  };
  videoTextData: {
    fullText: string;
    segmentCount: number;
    detectionCount: number;
  } | null;
}

export function generateHtmlReport(result: ReportData): string {
  const statusColor: Record<'SAFE' | 'CAUTION' | 'UNSAFE', string> = {
    SAFE: '#10b981',
    CAUTION: '#f59e0b',
    UNSAFE: '#ef4444'
  };

  const statusIcon: Record<'SAFE' | 'CAUTION' | 'UNSAFE', string> = {
    SAFE: '✓',
    CAUTION: '⚠',
    UNSAFE: '✗'
  };

  const currentStatusColor = statusColor[result.overallAssessment];
  const currentStatusIcon = statusIcon[result.overallAssessment];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Content Scan Report - ${result.scanId}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #1f2937;
      background: #f9fafb;
      padding: 2rem;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      border-radius: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 2rem;
    }
    .header h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    .header p { opacity: 0.9; }
    .content { padding: 2rem; }
    .section {
      margin-bottom: 2rem;
      padding-bottom: 2rem;
      border-bottom: 1px solid #e5e7eb;
    }
    .section:last-child { border-bottom: none; }
    .section h2 {
      font-size: 1.5rem;
      margin-bottom: 1rem;
      color: #111827;
    }
    .assessment-badge {
      display: inline-block;
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      font-size: 1.25rem;
      font-weight: 600;
      color: white;
      background: ${currentStatusColor};
      margin: 1rem 0;
    }
    .info-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 1rem;
      margin: 1rem 0;
    }
    .info-item {
      background: #f9fafb;
      padding: 1rem;
      border-radius: 8px;
      border-left: 4px solid #667eea;
    }
    .info-label {
      font-size: 0.875rem;
      color: #6b7280;
      margin-bottom: 0.25rem;
    }
    .info-value {
      font-size: 1.125rem;
      font-weight: 600;
      color: #111827;
    }
    .finding {
      background: #fef3c7;
      border-left: 4px solid #f59e0b;
      padding: 1rem;
      margin: 0.5rem 0;
      border-radius: 4px;
    }
    .finding.safe {
      background: #d1fae5;
      border-left-color: #10b981;
    }
    .finding.danger {
      background: #fee2e2;
      border-left-color: #ef4444;
    }
    .finding-title {
      font-weight: 600;
      margin-bottom: 0.5rem;
    }
    .entity-list {
      margin: 0.5rem 0;
      padding-left: 1.5rem;
    }
    .entity-item {
      margin: 0.25rem 0;
      font-size: 0.875rem;
    }
    .approval-section {
      background: #f3f4f6;
      padding: 1.5rem;
      border-radius: 8px;
      margin-top: 1rem;
    }
    .approval-status {
      display: inline-block;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      font-weight: 600;
      background: #fbbf24;
      color: #78350f;
    }
    .footer {
      background: #f9fafb;
      padding: 1.5rem 2rem;
      text-align: center;
      color: #6b7280;
      font-size: 0.875rem;
    }
    .ai-summary {
      background: #ede9fe;
      border-left: 4px solid #8b5cf6;
      padding: 1.5rem;
      border-radius: 8px;
      margin: 1rem 0;
      font-size: 1.05rem;
      line-height: 1.8;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Content Scan Report</h1>
      <p>Scan ID: ${result.scanId}</p>
      <p>Generated: ${new Date(result.completedAt).toLocaleString()}</p>
    </div>

    <div class="content">
      <!-- Overall Assessment -->
      <div class="section">
        <h2>Overall Assessment</h2>
        <div class="assessment-badge">
          ${currentStatusIcon} ${result.overallAssessment}
        </div>
        
        <div class="ai-summary">
          <strong>AI Summary:</strong><br>
          ${result.aiSummary.summary}
        </div>

        <div class="info-grid">
          <div class="info-item">
            <div class="info-label">User ID</div>
            <div class="info-value">${result.userId}</div>
          </div>
          <div class="info-item">
            <div class="info-label">File</div>
            <div class="info-value">${result.objectKey.split('/').pop()}</div>
          </div>
          <div class="info-item">
            <div class="info-label">File Size</div>
            <div class="info-value">${(result.fileSize / 1024 / 1024).toFixed(2)} MB</div>
          </div>
          <div class="info-item">
            <div class="info-label">Status</div>
            <div class="info-value">${result.status.toUpperCase()}</div>
          </div>
        </div>
      </div>

      <!-- Toxicity Analysis -->
      <div class="section">
        <h2>Toxicity Analysis</h2>
        ${result.analysis.overall.toxicity.hasToxicContent ? `
          <div class="finding danger">
            <div class="finding-title">⚠️ Toxic Content Detected</div>
            <ul class="entity-list">
              ${(result.analysis.overall.toxicity.labels || []).map((l: any) => 
                `<li class="entity-item">${l.Name}: ${(l.Score * 100).toFixed(1)}% confidence</li>`
              ).join('')}
            </ul>
          </div>
        ` : `
          <div class="finding safe">
            <div class="finding-title">✓ No Toxic Content Detected</div>
            <p>The content passed toxicity screening.</p>
          </div>
        `}
      </div>

      <!-- Sentiment Analysis -->
      <div class="section">
        <h2>Sentiment Analysis</h2>
        <div class="finding ${result.analysis.overall.sentiment.sentiment === 'POSITIVE' ? 'safe' : result.analysis.overall.sentiment.sentiment === 'NEGATIVE' ? 'danger' : ''}">
          <div class="finding-title">Overall Sentiment: ${result.analysis.overall.sentiment.sentiment}</div>
          ${result.analysis.overall.sentiment.sentimentScore ? `
            <ul class="entity-list">
              <li class="entity-item">Positive: ${(result.analysis.overall.sentiment.sentimentScore.Positive * 100).toFixed(1)}%</li>
              <li class="entity-item">Negative: ${(result.analysis.overall.sentiment.sentimentScore.Negative * 100).toFixed(1)}%</li>
              <li class="entity-item">Neutral: ${(result.analysis.overall.sentiment.sentimentScore.Neutral * 100).toFixed(1)}%</li>
              <li class="entity-item">Mixed: ${(result.analysis.overall.sentiment.sentimentScore.Mixed * 100).toFixed(1)}%</li>
            </ul>
          ` : ''}
        </div>
      </div>

      <!-- PII Detection -->
      <div class="section">
        <h2>Personal Information (PII) Detection</h2>
        ${result.analysis.overall.pii.hasPII ? `
          <div class="finding danger">
            <div class="finding-title">⚠️ PII Detected (${result.analysis.overall.pii.entityCount} entities)</div>
            <p><strong>Types Found:</strong></p>
            <ul class="entity-list">
              ${Object.entries(result.analysis.overall.pii.entityTypes).map(([type, count]) => 
                `<li class="entity-item">${type}: ${count} occurrence(s)</li>`
              ).join('')}
            </ul>
            <p style="margin-top: 1rem;"><strong>Source Breakdown:</strong></p>
            <ul class="entity-list">
              <li class="entity-item">Audio: ${result.analysis.summary.audioIssues.pii} entities</li>
              <li class="entity-item">Screen: ${result.analysis.summary.screenIssues.pii} entities</li>
            </ul>
          </div>
        ` : `
          <div class="finding safe">
            <div class="finding-title">✓ No PII Detected</div>
            <p>No personal information was found in the content.</p>
          </div>
        `}
      </div>

      <!-- Video Text Detection -->
      <div class="section">
        <h2>Video Text Detection</h2>
        ${result.videoTextData ? `
          <div class="finding safe">
            <div class="finding-title">✓ Text Extraction Successful</div>
            <ul class="entity-list">
              <li class="entity-item">Unique text segments: ${result.videoTextData.segmentCount}</li>
              <li class="entity-item">Total detections: ${result.videoTextData.detectionCount}</li>
            </ul>
          </div>
        ` : `
          <div class="finding">
            <div class="finding-title">⚠️ Video Text Detection Unavailable</div>
            <p>${result.warnings.length > 0 ? result.warnings[0] : 'Video text detection was not performed or failed.'}</p>
          </div>
        `}
      </div>

      <!-- Approval Section -->
      <div class="section">
        <h2>Approval Status</h2>
        <div class="approval-section">
          <div class="approval-status">PENDING REVIEW</div>
          <p style="margin-top: 1rem; color: #6b7280;">
            This content is awaiting manual review by an administrator.
          </p>
        </div>
      </div>
    </div>

    <div class="footer">
      <p>Content Scanner Report • Generated by AWS Lambda</p>
      <p>Scan ID: ${result.scanId}</p>
    </div>
  </div>
</body>
</html>`;
}
