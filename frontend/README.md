# Video Scanner Frontend

A Nuxt 3 application providing a modern web interface for the Video Scanner content analysis pipeline. Features real-time updates via AppSync Events, user authentication with Cognito, and admin capabilities for user management and content approval.

## Tech Stack

- **Nuxt 3** - Vue.js framework with SSR support
- **Tailwind CSS** - Utility-first CSS framework
- **AWS Cognito** - User authentication and authorization
- **AWS AppSync Events** - Real-time event subscriptions
- **TypeScript** - Type-safe development

## Prerequisites

- Node.js 24.x or later
- Backend deployed (see main README)
- SAM stack outputs for environment configuration

## Setup

### 1. Get Backend Configuration

After deploying the backend with SAM, retrieve the stack outputs:

```bash
# From the project root
aws cloudformation describe-stacks \
  --stack-name scanner-app \
  --query 'Stacks[0].Outputs[?OutputKey==`FrontendEnvFile`].OutputValue' \
  --output text
```

### 2. Configure Environment Variables

Create a `.env` file in the `frontend/` directory:

```bash
# Automatically create from stack outputs
aws cloudformation describe-stacks \
  --stack-name scanner-app \
  --query 'Stacks[0].Outputs[?OutputKey==`FrontendEnvFile`].OutputValue' \
  --output text > .env
```

Or manually create `.env` with these values:

```env
NUXT_PUBLIC_API_ENDPOINT=https://your-api-id.execute-api.us-west-2.amazonaws.com/prod
NUXT_PUBLIC_USER_POOL_ID=us-west-2_xxxxxxxxx
NUXT_PUBLIC_USER_POOL_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
NUXT_PUBLIC_APPSYNC_HTTP_ENDPOINT=https://xxx.appsync-api.us-west-2.amazonaws.com/event
NUXT_PUBLIC_APPSYNC_REALTIME_ENDPOINT=wss://xxx.appsync-realtime-api.us-west-2.amazonaws.com/event/realtime
NUXT_PUBLIC_REGION=us-west-2
```

Replace the placeholder values with actual outputs from your SAM stack.

### 3. Install Dependencies

```bash
npm install
```

### 4. Run Development Server

```bash
npm run dev
```

The application will be available at `http://localhost:3000`

## First Login

### Admin User Setup

When you deployed the backend, you provided an admin email address. This user was automatically created in Cognito:

1. Navigate to `http://localhost:3000`
2. Click "Sign In"
3. Enter your admin email address
4. Enter the temporary password from the email you received
5. You'll be prompted to set a new permanent password
6. After changing the password, you'll be logged in with admin privileges

**Note:** The temporary password email is sent by AWS Cognito. Check your spam folder if you don't see it.

## Features

### For All Users

- **Dashboard**: View your uploaded videos and scan results
- **Upload Videos**: Generate presigned URLs and upload videos directly to S3
- **Real-time Updates**: See scan progress updates via AppSync Events
- **Scan History**: Browse all your previous scans
- **Detailed Reports**: View comprehensive analysis results including:
  - Toxicity detection (7 categories)
  - Sentiment analysis
  - PII detection with source mapping (audio vs screen)
  - AI-generated summary
  - Overall safety assessment
- **Video Playback**: Stream videos directly from S3 with presigned URLs
- **Profile Management**: Update your user profile

### For Admin Users

- **User Management**:
  - Invite new users via email
  - View all users in the system
  - Delete users (except yourself)
- **Content Moderation**:
  - View all pending scans across all users
  - Approve or reject video content
  - Add review comments
- **System Overview**: Monitor all scans and approval workflows

## User Management

### Inviting New Users

As an admin:

1. Navigate to **Admin → Users**
2. Click **"Invite User"**
3. Enter the new user's email address
4. Click **"Send Invitation"**

The new user will receive:
- An email from AWS Cognito with a temporary password
- Instructions to log in and change their password

### User Roles

**Admin Users:**
- Full access to all features
- Can invite and manage users
- Can view and moderate all scans
- Cannot delete themselves

**Regular Users:**
- Can upload and view their own videos
- Can see their own scan history
- Cannot access admin features
- Cannot view other users' content

## Real-time Updates

The application uses AWS AppSync Events for real-time updates. When a scan progresses through its workflow, you'll see live updates for:

- `SCAN_STARTED` - Video upload detected
- `TRANSCRIPTION_COMPLETED` - Audio transcription finished
- `REKOGNITION_COMPLETED` - Video text detection finished
- `ANALYSIS_COMPLETED` - Content analysis finished
- `REPORT_GENERATED` - Final report created
- `PENDING_REVIEW` - Awaiting approval
- `APPROVED` / `REJECTED` - Final decision made

Updates appear automatically without refreshing the page.

## Project Structure

```
frontend/
├── components/
│   ├── AppNav.vue           # Navigation bar with auth
│   └── VideoPlayer.vue      # Video playback component
├── composables/
│   ├── useApi.ts            # API client wrapper
│   ├── useAuth.ts           # Cognito authentication
│   └── useRealtimeUpdates.ts # AppSync Events subscriptions
├── middleware/
│   └── auth.ts              # Route protection
├── pages/
│   ├── admin/
│   │   ├── index.vue        # Admin dashboard
│   │   └── users.vue        # User management
│   ├── scan/
│   │   └── [id].vue         # Scan detail view
│   ├── dashboard.vue        # User dashboard
│   ├── index.vue            # Landing page
│   └── profile.vue          # User profile
├── services/
│   └── appSyncEvents.ts     # AppSync Events client
├── app.vue                  # Root component
├── nuxt.config.ts           # Nuxt configuration
└── tailwind.config.js       # Tailwind configuration
```

## Development

### Build for Production

```bash
npm run build
```

### Preview Production Build

```bash
npm run preview
```

### Type Checking

```bash
npm run typecheck
```

## Deployment

### Static Hosting (S3 + CloudFront)

1. Build the application:
```bash
npm run generate
```

2. Deploy to S3:
```bash
aws s3 sync .output/public s3://your-frontend-bucket/
```

3. Invalidate CloudFront cache:
```bash
aws cloudfront create-invalidation \
  --distribution-id YOUR-DISTRIBUTION-ID \
  --paths "/*"
```

### Server-Side Rendering (Lambda)

For SSR deployment, consider using:
- AWS Amplify Hosting
- Vercel
- Netlify
- Custom Lambda@Edge setup

## Troubleshooting

### Authentication Issues

**Problem:** Can't log in with temporary password

**Solutions:**
- Check that the email matches exactly what was used in SAM deployment
- Verify the temporary password hasn't expired (7 days)
- Check spam folder for the Cognito email
- Ensure `NUXT_PUBLIC_USER_POOL_ID` and `NUXT_PUBLIC_USER_POOL_CLIENT_ID` are correct

### Real-time Updates Not Working

**Problem:** Not seeing live scan updates

**Solutions:**
- Verify `NUXT_PUBLIC_APPSYNC_HTTP_ENDPOINT` and `NUXT_PUBLIC_APPSYNC_REALTIME_ENDPOINT` are correct
- Check browser console for WebSocket connection errors
- Ensure you're authenticated (AppSync requires valid Cognito token)
- Check that the backend is publishing events correctly

### API Errors

**Problem:** API calls failing with 401/403

**Solutions:**
- Verify `NUXT_PUBLIC_API_ENDPOINT` is correct
- Check that your Cognito token is valid (try logging out and back in)
- Ensure the API Gateway authorizer is configured correctly
- Check CloudWatch logs for the API Lambda functions

### Video Upload Fails

**Problem:** Can't upload videos

**Solutions:**
- Check that presigned URL generation is working (`POST /scans/upload`)
- Verify S3 bucket CORS configuration allows uploads
- Ensure file size is within limits
- Check browser console for CORS errors

## Environment Variables Reference

| Variable | Description | Example |
|----------|-------------|---------|
| `NUXT_PUBLIC_API_ENDPOINT` | REST API base URL | `https://xxx.execute-api.us-west-2.amazonaws.com/prod` |
| `NUXT_PUBLIC_USER_POOL_ID` | Cognito User Pool ID | `us-west-2_xxxxxxxxx` |
| `NUXT_PUBLIC_USER_POOL_CLIENT_ID` | Cognito App Client ID | `xxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `NUXT_PUBLIC_APPSYNC_HTTP_ENDPOINT` | AppSync Events HTTP endpoint | `https://xxx.appsync-api.us-west-2.amazonaws.com/event` |
| `NUXT_PUBLIC_APPSYNC_REALTIME_ENDPOINT` | AppSync Events WebSocket endpoint | `wss://xxx.appsync-realtime-api.us-west-2.amazonaws.com/event/realtime` |
| `NUXT_PUBLIC_REGION` | AWS region | `us-west-2` |

All variables are prefixed with `NUXT_PUBLIC_` to make them available in the browser.

## License

Apache 2.0
