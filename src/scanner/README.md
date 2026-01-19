# Video Content Scanner - Durable Function

A serverless video content moderation system built with AWS Lambda Durable Functions. This function demonstrates advanced orchestration patterns including parallel execution, async callbacks, and human-in-the-loop workflows.

## 🎯 Overview

The scanner analyzes video content for:
- **Toxicity**: Harmful or offensive language
- **Sentiment**: Emotional tone (positive, negative, neutral, mixed)
- **PII**: Personal identifiable information (names, addresses, phone numbers, etc.)
- **Video Text**: On-screen text detection via Rekognition

Results are combined from both audio transcription and video text detection, then mapped back to their sources (audio vs screen) for detailed analysis.

## 🏗️ Architecture

```
S3 Upload (EventBridge)
    ↓
Scanner Durable Function
    ↓
┌─────────────────────────────────────────────────────────┐
│ STEP 1-4: Parallel Async Jobs (context.parallel)       │
│   ├─ Branch 1: Transcribe Audio                        │
│   │   ├─ Start job (context.waitForCallback)           │
│   │   └─ Fetch transcript from S3                      │
│   └─ Branch 2: Rekognition Video Text                  │
│       ├─ Start job (context.waitForCallback)           │
│       └─ Extract text detections                       │
└─────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────┐
│ STEP 5: Build Corpus (context.step)                    │
│   - Combine audio + video text                         │
│   - Create position index for source mapping           │
└─────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────┐
│ STEP 6: Parallel Analysis (context.parallel)           │
│   ├─ Toxicity Detection (Comprehend)                   │
│   ├─ Sentiment Analysis (Comprehend)                   │
│   └─ PII Detection (Comprehend)                        │
└─────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────┐
│ STEP 7: Map to Sources (context.step)                  │
│   - Identify which PII came from audio vs screen       │
└─────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────┐
│ STEP 8: AI Summary (context.step)                      │
│   - Generate executive summary with Bedrock Nova Lite  │
└─────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────┐
│ STEP 9: Save Results (context.step)                    │
│   - Generate JSON + HTML reports → S3                  │
│   - Save metadata → DynamoDB                           │
└─────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────┐
│ STEP 10: Human Approval (context.waitForCallback)      │
│   - Wait up to 3 days for approval/rejection           │
│   - Auto-reject on timeout                             │
└─────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────┐
│ STEP 11: Update Status (context.step)                  │
│   - Mark as APPROVED or REJECTED in DynamoDB           │
└─────────────────────────────────────────────────────────┘
```

## 📁 Project Structure

```
src/scanner/
├── index.ts                    # Main durable function (280 lines)
├── config.ts                   # Service clients, types, constants
├── analysis/
│   ├── corpus.ts              # Corpus building & source mapping
│   ├── toxicity.ts            # Toxicity detection (Comprehend)
│   ├── sentiment.ts           # Sentiment analysis (Comprehend)
│   └── pii.ts                 # PII detection (Comprehend)
├── jobs/
│   ├── transcribe.ts          # Transcribe workflow with callbacks
│   └── rekognition.ts         # Rekognition workflow with callbacks
├── storage/
│   ├── dynamodb.ts            # DynamoDB operations & approval
│   └── s3.ts                  # S3 report generation
└── reporting/
    ├── html-generator.ts      # HTML report generator
    └── ai-summary.ts          # Bedrock AI summary generation
```

## 🚀 Durable Function Patterns Demonstrated

### 1. **Parallel Execution** (`context.parallel`)
```typescript
const results = await context.parallel([
  async (childContext) => runTranscribeWorkflow(childContext, ...),
  async (childContext) => runRekognitionWorkflow(childContext, ...)
]);
```
- Runs Transcribe and Rekognition jobs concurrently
- Each branch uses a child context (best practice)
- Reduces total execution time by ~50%

### 2. **Async Callbacks** (`context.waitForCallback`)
```typescript
const result = await context.waitForCallback(
  'transcription-result',
  async (callbackToken) => {
    // Start async job
    await transcribe.send(new StartTranscriptionJobCommand(...));
    // Store callback token in DynamoDB
    await ddb.send(new PutItemCommand({ callbackToken, ... }));
  },
  { timeout: { seconds: 1800 } }
);
```
- Handles long-running AWS service jobs (Transcribe, Rekognition)
- Stores callback tokens in DynamoDB for later retrieval
- Callback function sends results back to durable execution

### 3. **State Management** (`context.step`)
```typescript
const corpus = await context.step('build-corpus', async () => {
  return buildCorpus(transcriptData, videoTextData);
});
```
- Idempotent operations that can be safely retried
- State is persisted between retries
- Enables workflow resumption after failures

### 4. **Human-in-the-Loop**
```typescript
const approval = await context.waitForCallback(
  'human-approval',
  async (callbackToken) => { /* Store token */ },
  { timeout: { seconds: 259200 } } // 3 days
);
```
- Waits for human approval/rejection
- 3-day timeout with auto-rejection
- Demonstrates long-running workflows

## 🧪 Testing

### Upload a Test Video
```bash
# Upload to S3 (triggers the scanner)
aws s3 cp test-video.mp4 s3://YOUR-BUCKET/raw/testuser/video.mp4
```

### Submit Approval
```bash
# Approve a scan
echo '{"scanId":"SCAN-ID","approved":true,"reviewedBy":"admin","comments":"Looks good"}' | \
  aws lambda invoke \
  --function-name callback-function \
  --cli-binary-format raw-in-base64-out \
  --payload file:///dev/stdin \
  response.json
```

### Submit Rejection
```bash
# Reject a scan
echo '{"scanId":"SCAN-ID","approved":false,"reviewedBy":"admin","comments":"Policy violation"}' | \
  aws lambda invoke \
  --function-name callback-function \
  --cli-binary-format raw-in-base64-out \
  --payload file:///dev/stdin \
  response.json
```

### Query Scan Results
```bash
# Get scan metadata from DynamoDB
aws dynamodb get-item \
  --table-name scanner-table \
  --key '{"PK":{"S":"SCAN#YOUR-SCAN-ID"},"SK":{"S":"METADATA"}}'
```

### View Reports
```bash
# Download JSON report
aws s3 cp s3://YOUR-BUCKET/reports/SCAN-ID.json ./report.json

# Download HTML report
aws s3 cp s3://YOUR-BUCKET/reports/SCAN-ID.html ./report.html
open report.html
```

## 📊 DynamoDB Schema

### Single Table Design

**Primary Key**: `PK` (partition key), `SK` (sort key)

#### Scan Metadata
```
PK: SCAN#{scanId}
SK: METADATA
GSI1PK: USER#{userId}
GSI1SK: {uploadedAt}
GSI2PK: STATUS#{approvalStatus}
GSI2SK: {uploadedAt}
```

#### Callback Tokens
```
PK: SCAN#{scanId}
SK: TOKEN#{jobName}
TTL: {expiresAt}
```

### Access Patterns
1. Get scan by ID: `PK = SCAN#{scanId}, SK = METADATA`
2. List scans by user: `GSI1PK = USER#{userId}`
3. List scans by status: `GSI2PK = STATUS#{status}`
4. Get callback token: `PK = SCAN#{scanId}, SK = TOKEN#{jobName}`

## 🔧 Configuration

### Environment Variables
- `SCANNER_TABLE`: DynamoDB table name
- `REKOGNITION_ROLE_ARN`: IAM role for Rekognition
- `REKOGNITION_SNS_TOPIC_ARN`: SNS topic for Rekognition callbacks
- `BEDROCK_MODEL_ID`: Bedrock model (default: `global.amazon.nova-2-lite-v1:0`)
- `POWERTOOLS_SERVICE_NAME`: Service name for logging
- `POWERTOOLS_LOG_LEVEL`: Log level (INFO, DEBUG, etc.)

### Timeouts
- **Transcribe callback**: 30 minutes (1800 seconds)
- **Rekognition callback**: 30 minutes (1800 seconds)
- **Human approval**: 3 days (259200 seconds)
- **Lambda execution**: 15 minutes (900 seconds)
- **Durable execution**: 7 days (604800 seconds)

## 📈 Monitoring

### CloudWatch Logs
- **Scanner Function**: `/aws/lambda/scanner-function`
- **Callback Function**: `/aws/lambda/callback-function`

### Key Metrics to Watch
- Durable execution duration
- Callback timeout rate
- Analysis failure rate
- Approval response time
- Cost per scan

### X-Ray Tracing
All functions have X-Ray tracing enabled. View traces in the AWS X-Ray console to see:
- End-to-end execution flow
- Service call latencies
- Error rates by service

## 💰 Cost Estimation

Per video scan (5-minute video):
- **Transcribe**: ~$0.015 (audio transcription)
- **Rekognition**: ~$0.05 (text detection)
- **Comprehend**: ~$0.003 (toxicity, sentiment, PII)
- **Bedrock**: ~$0.001 (Nova Lite summary)
- **Lambda**: ~$0.002 (execution time)
- **DynamoDB**: ~$0.0001 (on-demand)
- **S3**: ~$0.0001 (storage + requests)

**Total**: ~$0.07 per scan

## 🛡️ Error Handling

### Retry Strategy
- **Transcribe/Rekognition failures**: No automatic retries (callback strategy)
- **Comprehend failures**: Retries with exponential backoff
- **Bedrock failures**: Graceful degradation (returns error message)
- **DynamoDB failures**: Automatic retries via SDK

### Failure Scenarios
1. **Transcribe fails**: Execution fails, no transcript available
2. **Rekognition fails**: Continues with audio-only analysis
3. **Analysis fails**: Partial results returned with warnings
4. **Approval timeout**: Auto-rejects after 3 days

## 🔐 Security

### IAM Permissions
- **S3**: Read uploaded videos, write reports
- **Transcribe**: Start/get transcription jobs
- **Rekognition**: Start/get text detection jobs
- **Comprehend**: Detect toxicity, sentiment, PII
- **Bedrock**: Invoke Nova Lite model
- **DynamoDB**: CRUD operations on scanner table
- **Lambda**: Send durable execution callbacks

### Data Protection
- Videos stored in S3 with encryption at rest
- DynamoDB encrypted with AWS managed keys
- Callback tokens have 24-hour TTL
- Reports contain sensitive data - consider access controls

## 📝 Development

### Local Development
```bash
# Install dependencies
npm install

# Run TypeScript compiler
npm run build

# Run tests (when added)
npm test
```

### Deployment
```bash
# Using SAM sync (recommended for development)
sam sync --watch

# Or build and deploy
sam build
sam deploy
```

### Adding New Analysis
1. Create new file in `analysis/` directory
2. Export async function that takes text and returns results
3. Add to parallel execution in `index.ts` Step 6
4. Update types in `config.ts`

## 🎓 Learning Resources

- [AWS Lambda Durable Functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html)
- [AWS Lambda Powertools TypeScript](https://docs.aws.amazon.com/powertools/typescript/latest/)
- [Amazon Transcribe](https://docs.aws.amazon.com/transcribe/)
- [Amazon Rekognition](https://docs.aws.amazon.com/rekognition/)
- [Amazon Comprehend](https://docs.aws.amazon.com/comprehend/)
- [Amazon Bedrock](https://docs.aws.amazon.com/bedrock/)

## 🤝 Contributing

This is a demo project showcasing durable function patterns. Feel free to:
- Add new analysis modules
- Improve error handling
- Add tests
- Enhance the HTML reports
- Build a web UI for approvals

## 📄 License

This is a demonstration project. Use at your own discretion.
