import { appSyncEvents } from '~/services/appSyncEvents';

export const useRealtimeUpdates = () => {
  const config = useRuntimeConfig();
  const { user, getIdToken, isAdmin } = useAuth();
  const connected = ref(false);

  const connect = async () => {
    if (!user.value) return;

    try {
      const token = await getIdToken();
      appSyncEvents.configure(
        config.public.appSyncHttpEndpoint,
        config.public.appSyncRealtimeEndpoint,
        token
      );
      
      await appSyncEvents.connect();
      connected.value = true;

      // Subscribe to user-specific scan updates
      appSyncEvents.subscribe(`default/scan-updates-${user.value.username}`, (event) => {
        console.log('[Realtime] Scan update:', event);
        window.dispatchEvent(new CustomEvent('scan-update', { detail: event }));
      });
      
      // Subscribe to admin channel if user is admin
      if (isAdmin.value) {
        appSyncEvents.subscribe('default/admin-pending-reviews', (event) => {
          console.log('[Realtime] Admin pending review:', event);
          window.dispatchEvent(new CustomEvent('admin-pending-review', { detail: event }));
        });
      }
    } catch (error) {
      console.error('[Realtime] Connection failed:', error);
      connected.value = false;
    }
  };

  const disconnect = () => {
    appSyncEvents.disconnect();
    connected.value = false;
  };

  return {
    connected,
    connect,
    disconnect,
  };
};
