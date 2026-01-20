import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

const APPSYNC_EVENTS_API_URL = process.env.APPSYNC_EVENTS_API_URL!;
const AWS_REGION = process.env.AWS_REGION || 'us-west-2';

interface EventData {
  type: string;
  scanId: string;
  userId: string;
  timestamp: string;
  data?: any;
}

/**
 * Publish event to AppSync Events API
 */
export async function publishEvent(event: EventData): Promise<void> {
  if (!APPSYNC_EVENTS_API_URL) {
    console.warn('APPSYNC_EVENTS_API_URL not configured, skipping event publish');
    return;
  }

  const url = new URL(APPSYNC_EVENTS_API_URL);
  const body = JSON.stringify(event);

  const request = new HttpRequest({
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'host': url.hostname,
    },
    body,
  });

  const signer = new SignatureV4({
    service: 'appsync',
    region: AWS_REGION,
    credentials: defaultProvider(),
    sha256: Sha256,
  });

  const signedRequest = await signer.sign(request);

  const response = await fetch(`https://${signedRequest.hostname}${signedRequest.path}`, {
    method: signedRequest.method,
    headers: signedRequest.headers as Record<string, string>,
    body: signedRequest.body,
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('Failed to publish event:', error);
    throw new Error(`AppSync Events publish failed: ${response.status}`);
  }

  console.log(`Published event: ${event.type} for scan ${event.scanId}`);
}

/**
 * Publish to multiple channels
 */
export async function publishToChannels(
  channels: string[],
  event: EventData
): Promise<void> {
  await Promise.all(
    channels.map(channel =>
      publishEvent({
        ...event,
        data: {
          ...event.data,
          channel,
        },
      })
    )
  );
}
