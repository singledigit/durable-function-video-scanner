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
  private url: string = '';
  private connectionState: ConnectionState = ConnectionState.DISCONNECTED;
  private subscriptions: Map<string, Subscription[]> = new Map();
  private subscriptionIdToChannel: Map<string, string> = new Map();
  private reconnectionAttempts: number = 0;
  private reconnectionTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private connectionStateCallbacks: Set<(state: ConnectionState) => void> = new Set();
  private shouldReconnect: boolean = true;
  private authToken: string = '';

  configure(url: string, authToken: string) {
    this.url = url;
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

    if (!this.url || !this.authToken) {
      throw new Error('AppSync Events not configured');
    }

    this.setConnectionState(ConnectionState.CONNECTING);
    this.shouldReconnect = true;

    try {
      const wsUrl = this.buildWebSocketUrl();
      const authSubprotocol = this.getAuthSubprotocol();
      
      this.ws = new WebSocket(wsUrl, [authSubprotocol, 'aws-appsync-event-ws']);
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

  private buildWebSocketUrl(): string {
    // URL should be the HTTP endpoint like: https://xxx.appsync-api.region.amazonaws.com/event
    const httpUrl = new URL(this.url);
    const realtimeHost = httpUrl.host.replace('.appsync-api.', '.appsync-realtime-api.');
    return `wss://${realtimeHost}/event/realtime`;
  }

  private getBase64URLEncoded(obj: any): string {
    return btoa(JSON.stringify(obj))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  private getAuthSubprotocol(): string {
    // CRITICAL: Use HTTP endpoint host for auth, not realtime host
    // URL should be like: https://xxx.appsync-api.region.amazonaws.com/event
    const httpUrl = new URL(this.url);
    const httpHost = httpUrl.host.replace('.appsync-realtime-api.', '.appsync-api.');
    
    const authObject = {
      host: httpHost,
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
      const message = JSON.parse(event.data);
      
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
      
      if (message.type === 'subscribe_success') {
        console.log('[AppSync Events] Subscription confirmed:', message.id);
        return;
      }

      if (message.type === 'data') {
        const channel = this.subscriptionIdToChannel.get(message.id);
        if (channel) {
          const callbacks = this.subscriptions.get(channel);
          // Parse the event string into an object
          const eventData = typeof message.event === 'string' ? JSON.parse(message.event) : message.event;
          callbacks?.forEach(sub => sub.callback(eventData));
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
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
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
      
      const httpUrl = new URL(this.url);
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
