export default defineNuxtConfig({
  modules: ['@nuxtjs/tailwindcss'],
  
  runtimeConfig: {
    public: {
      apiEndpoint: process.env.NUXT_PUBLIC_API_ENDPOINT || '',
      userPoolId: process.env.NUXT_PUBLIC_USER_POOL_ID || '',
      userPoolClientId: process.env.NUXT_PUBLIC_USER_POOL_CLIENT_ID || '',
      appSyncHttpEndpoint: process.env.NUXT_PUBLIC_APPSYNC_HTTP_ENDPOINT || '',
      appSyncRealtimeEndpoint: process.env.NUXT_PUBLIC_APPSYNC_REALTIME_ENDPOINT || '',
      region: process.env.NUXT_PUBLIC_REGION || 'us-west-2',
    },
  },

  devtools: { enabled: true },
  compatibilityDate: '2024-01-01',
})
