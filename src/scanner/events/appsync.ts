import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { logger, APPSYNC_EVENTS_API_URL, AWS_REGION } from '../config';

interface EventData {
  type: string;
  scanId: string;
  userId: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

/**
 * Publish event to AppSync Events API
 */
export async function publishEvent(event: EventData): Promise<void> {
  if (!APPSYNC_EVENTS_API_URL) {
    logger.warn('APPSYNC_EVENTS_API_URL not configured, skipping event publish');
    return;
  }

  try {
    const url = new URL(APPSYNC_EVENTS_API_URL);
    
    // Publish to both user-specific channel and admin channel
    // Channels must start with / per AppSync Events API requirements
    const channels = [
      `/default/scan-updates-${event.userId}`,
    ];
    
    // Add admin channel for PENDING_REVIEW events
    if (event.type === 'PENDING_REVIEW') {
      channels.push('/default/admin-pending-reviews');
    }
    
    // Publish to each channel separately
    for (const channel of channels) {
      // Events must be stringified JSON per AppSync Events API requirements
      const body = JSON.stringify({
        channel,
        events: [JSON.stringify(event)],
      });
      
      logger.info('Publishing event to channel', { channel, eventType: event.type, scanId: event.scanId });

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
        logger.error('Failed to publish event to channel', { 
          channel, 
          eventType: event.type,
          status: response.status,
          error 
        });
        throw new Error(`AppSync Events publish failed: ${response.status}`);
      }

      logger.info('Successfully published event', { 
        channel, 
        eventType: event.type, 
        scanId: event.scanId 
      });
    }
  } catch (error) {
    logger.error('Error publishing event', {
      error: error instanceof Error ? error.message : String(error),
      eventType: event.type,
      scanId: event.scanId
    });
    // Don't throw - allow workflow to continue even if event publishing fails
  }
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
