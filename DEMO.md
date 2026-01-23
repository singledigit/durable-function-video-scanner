# Video Scanner - AWS Lambda Durable Functions Demo

A production-ready serverless video content analysis pipeline demonstrating AWS Lambda Durable Functions, real-time WebSocket updates, and human-in-the-loop workflows.

## Features

- **Durable Execution**: Long-running workflows with automatic state management
- **Parallel Processing**: Concurrent transcription and video analysis
- **Real-time Updates**: WebSocket notifications via AppSync Events
- **Human Approval**: 3-day timeout with automatic rejection
- **Multi-user Support**: User-based access control with admin review
- **Comprehensive Analysis**: Toxicity, sentiment, and PII detection
- **AI Summaries**: Amazon Bedrock Nova Lite for executive summaries

## Architecture

### Backend (AWS Lambda + SAM)
- **Scanner Function**: Durable orchestrator with 11 steps
- **Callback Function**: Unified handler for async job completions
- **API Functions**: REST endpoints for upload, list, get, approve
- **Services**: Amazon Transcribe, Rekognition, Comprehend, Bedrock
- **Storage**: S3 for videos/reports, DynamoDB for metadata

### Frontend (Nuxt 3 + Tailwind)
- **User Dashboard**: Upload videos, view scan results
- **Admin Panel**: Review pending scans, approve/reject
- **Scan Details**: Full analysis with AI summary
- **Real-time Updates**: WebSocket connection on login

## Quick Start

### Prerequisites
```bash
# Install AWS SAM CLI
brew install aws-sam-cli

# Configure AWS credentials
aws configure
```

### Deploy Backend
```bash
# Build and deploy
sam sync --watch

# Note the API endpoint and AppSync Events endpoint from outputs
```

### Setup Frontend
```bash
cd frontend

# Copy environment template
cp .env.example .env

# Edit .env with your endpoints:
# - NUXT_PUBLIC_API_ENDPOINT
# - NUXT_PUBLIC_APPSYNC_EVENTS_ENDPOINT
# - NUXT_PUBLIC_USER_POOL_ID
# - NUXT_PUBLIC_USER_POOL_CLIENT_ID

# Install and run
npm install
npm run dev
```

### Create Admin User
```bash
# Create user in Cognito
aws cognito-idp admin-create-user \
  --user-pool-id YOUR_POOL_ID \
  --username admin@example.com \
  --temporary-password TempPass123!

# Add to Admins group
aws cognito-idp admin-add-user-to-group \
  --user-pool-id YOUR_POOL_ID \
  --username admin@example.com \
  --group-name Admins
```

## Workflow

### User Flow
1. Login → WebSocket connects
2. Upload video → Scan starts
3. Receive 7 real-time events:
   - SCAN_STARTED
   - TRANSCRIPTION_COMPLETED
   - REKOGNITION_COMPLETED
   - ANALYSIS_COMPLETED
   - REPORT_GENERATED
   - PENDING_REVIEW
   - APPROVED/REJECTED
4. View results on dashboard

### Admin Flow
1. Login as admin
2. Navigate to `/admin`
3. Review pending scans
4. View details and approve/reject
5. User receives real-time notification

## Key Technologies

- **AWS Lambda Durable Functions**: Stateful workflows
- **AppSync Events**: WebSocket pub/sub
- **Amazon Transcribe**: Speech-to-text
- **Amazon Rekognition**: Video text detection
- **Amazon Comprehend**: Content analysis
- **Amazon Bedrock**: AI summaries
- **Nuxt 3**: Modern Vue framework
- **Tailwind CSS**: Utility-first styling

## Project Structure

```
.
├── src/
│   ├── scanner/              # Durable function
│   ├── callback/             # Async job handler
│   ├── api-*/                # REST endpoints
│   └── ...
├── frontend/
│   ├── pages/                # Routes
│   ├── composables/          # Vue composables
│   └── services/             # WebSocket service
├── template.yaml             # SAM infrastructure
└── README.md
```

## Demo Highlights

### Durable Functions Patterns
- ✅ `context.parallel()` for concurrent execution
- ✅ `context.waitForCallback()` for async jobs
- ✅ `context.step()` for idempotent operations
- ✅ Child contexts in parallel branches
- ✅ 3-day timeout with automatic fallback

### Real-time Features
- ✅ WebSocket connection on login
- ✅ User-specific event channels
- ✅ Automatic reconnection with backoff
- ✅ Keep-alive heartbeat

### Production Ready
- ✅ Error handling and retries
- ✅ CORS configuration
- ✅ Admin access control
- ✅ Multi-user support
- ✅ Comprehensive logging

## License

Apache 2.0
