export interface ScanEvent {
  type: string;
  scanId: string;
  userId: string;
  timestamp: string;
  data?: any;
}

export type EventCallback = (event: ScanEvent) => void;

export const ConnectionState = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  ERROR: 'ERROR'
} as const;

export type ConnectionState = typeof ConnectionState[keyof typeof ConnectionState];

interface Subscription {
  channel: string;
  callback: EventCallback;
}

class AppSyncEventsService {
  private ws: WebSocket | null = null;
  private httpEndpoint: string = '';
  private realtimeEndpoint: string = '';
  private connectionState: ConnectionState = ConnectionState.DISCONNECTED;
  private subscriptions: Map<string, Subscription[]> = new Map();
  private subscriptionIdToChannel: Map<string, string> = new Map();
  private reconnectionAttempts: number = 0;
  private reconnectionTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private connectionStateCallbacks: Set<(state: ConnectionState) => void> = new Set();
  private shouldReconnect: boolean = true;
  private authToken: string = '';

  configure(httpEndpoint: string, realtimeEndpoint: string, authToken: string) {
    this.httpEndpoint = httpEndpoint;
    this.realtimeEndpoint = realtimeEndpoint;
    this.authToken = authToken;
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  onConnectionStateChange(callback: (state: ConnectionState) => void): () => void {
    this.connectionStateCallbacks.add(callback);
    return () => this.connectionStateCallbacks.delete(callback);
  }

  private setConnectionState(state: ConnectionState): void {
    if (this.connectionState !== state) {
      this.connectionState = state;
      console.log(`[AppSync Events] Connection state: ${state}`);
      this.connectionStateCallbacks.forEach(callback => callback(state));
    }
  }

  async connect(): Promise<void> {
    if (this.connectionState === ConnectionState.CONNECTED || 
        this.connectionState === ConnectionState.CONNECTING) {
      return;
    }

    if (!this.httpEndpoint || !this.realtimeEndpoint || !this.authToken) {
      throw new Error('AppSync Events not configured');
    }

    this.setConnectionState(ConnectionState.CONNECTING);
    this.shouldReconnect = true;

    try {
      const authSubprotocol = this.getAuthSubprotocol();
      
      console.log('[AppSync Events] Connecting to:', this.realtimeEndpoint);
      console.log('[AppSync Events] Using HTTP host for auth:', new URL(this.httpEndpoint).host);
      
      this.ws = new WebSocket(this.realtimeEndpoint, [authSubprotocol, 'aws-appsync-event-ws']);
      this.ws.onopen = this.handleOpen.bind(this);
      this.ws.onmessage = this.handleMessage.bind(this);
      this.ws.onerror = this.handleError.bind(this);
      this.ws.onclose = this.handleClose.bind(this);
    } catch (error) {
      console.error('[AppSync Events] Connection error:', error);
      this.setConnectionState(ConnectionState.ERROR);
      this.scheduleReconnection();
      throw error;
    }
  }

  private getBase64URLEncoded(obj: any): string {
    return btoa(JSON.stringify(obj))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  private getAuthSubprotocol(): string {
    // Use HTTP endpoint host for auth (not realtime host)
    const httpUrl = new URL(this.httpEndpoint);
    
    const authObject = {
      host: httpUrl.host,
      Authorization: this.authToken
    };
    
    return `header-${this.getBase64URLEncoded(authObject)}`;
  }

  private handleOpen(): void {
    console.log('[AppSync Events] WebSocket connected');
    this.ws!.send(JSON.stringify({ type: 'connection_init' }));
  }

  private handleMessage(event: MessageEvent): void {
    try {
      console.log('[AppSync Events] Raw message received:', event.data);
      const message = JSON.parse(event.data);
      console.log('[AppSync Events] Parsed message:', message);
      
      if (message.type === 'connection_ack') {
        console.log('[AppSync Events] Connection acknowledged');
        this.setConnectionState(ConnectionState.CONNECTED);
        this.reconnectionAttempts = 0;
        this.startHeartbeat();
        this.resubscribeAll();
        return;
      }

      if (message.type === 'ka') {
        console.log('[AppSync Events] Keep-alive received');
        return;
      }
      
      if (message.type === 'error') {
        console.error('[AppSync Events] Error message received:', message.errors);
        return;
      }
      
      if (message.type === 'subscribe_success') {
        console.log('[AppSync Events] Subscription confirmed:', message.id);
        return;
      }

      if (message.type === 'data') {
        console.log('[AppSync Events] Data message received:', message);
        const channel = this.subscriptionIdToChannel.get(message.id);
        if (channel) {
          const callbacks = this.subscriptions.get(channel);
          // Parse the event string into an object
          const eventData = typeof message.event === 'string' ? JSON.parse(message.event) : message.event;
          console.log('[AppSync Events] Dispatching event to callbacks:', eventData);
          callbacks?.forEach(sub => sub.callback(eventData));
        } else {
          console.warn('[AppSync Events] No channel found for subscription:', message.id);
        }
      }
    } catch (error) {
      console.error('[AppSync Events] Message parse error:', error);
    }
  }

  private handleError(error: Event): void {
    console.error('[AppSync Events] WebSocket error:', error);
    this.setConnectionState(ConnectionState.ERROR);
  }

  private handleClose(): void {
    console.log('[AppSync Events] WebSocket closed');
    this.setConnectionState(ConnectionState.DISCONNECTED);
    this.stopHeartbeat();
    
    if (this.shouldReconnect) {
      this.scheduleReconnection();
    }
  }

  private startHeartbeat(): void {
    // AppSync Events server sends "ka" (keep-alive) messages to the client
    // The client should NOT send ping messages - just track the last received "ka"
    // If we don't receive a "ka" within connectionTimeoutMs, we should reconnect
    this.heartbeatInterval = setInterval(() => {
      // Just a placeholder to check connection health
      // The actual keep-alive is handled by the server's "ka" messages
      if (this.ws?.readyState !== WebSocket.OPEN) {
        console.warn('[AppSync Events] WebSocket not open, reconnecting...');
        this.scheduleReconnection();
      }
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private scheduleReconnection(): void {
    if (this.reconnectionTimer) return;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectionAttempts), 30000);
    this.reconnectionAttempts++;

    console.log(`[AppSync Events] Reconnecting in ${delay}ms (attempt ${this.reconnectionAttempts})`);
    
    this.reconnectionTimer = setTimeout(() => {
      this.reconnectionTimer = null;
      this.setConnectionState(ConnectionState.RECONNECTING);
      this.connect();
    }, delay);
  }

  subscribe(channel: string, callback: EventCallback): () => void {
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, []);
    }
    
    this.subscriptions.get(channel)!.push({ channel, callback });

    if (this.connectionState === ConnectionState.CONNECTED) {
      this.sendSubscription(channel);
    }

    return () => this.unsubscribe(channel, callback);
  }

  private sendSubscription(channel: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const subscriptionId = `sub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const formattedChannel = channel.startsWith('/') ? channel : `/${channel}`;
      
      this.subscriptionIdToChannel.set(subscriptionId, channel);
      
      const httpUrl = new URL(this.httpEndpoint);
      this.ws.send(JSON.stringify({
        type: 'subscribe',
        id: subscriptionId,
        channel: formattedChannel,
        authorization: {
          host: httpUrl.host,
          Authorization: this.authToken
        }
      }));
      
      console.log(`[AppSync Events] Subscribed to ${formattedChannel} (id: ${subscriptionId})`);
    }
  }

  private resubscribeAll(): void {
    this.subscriptions.forEach((_, channel) => {
      this.sendSubscription(channel);
    });
  }

  private unsubscribe(channel: string, callback: EventCallback): void {
    const subs = this.subscriptions.get(channel);
    if (subs) {
      const index = subs.findIndex(s => s.callback === callback);
      if (index !== -1) {
        subs.splice(index, 1);
      }
      if (subs.length === 0) {
        this.subscriptions.delete(channel);
      }
    }
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectionTimer) {
      clearTimeout(this.reconnectionTimer);
      this.reconnectionTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setConnectionState(ConnectionState.DISCONNECTED);
  }
}

export const appSyncEvents = new AppSyncEventsService();
