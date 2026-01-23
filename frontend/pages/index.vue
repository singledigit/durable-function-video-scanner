<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50">
    <div class="max-w-md w-full space-y-8 p-8 bg-white rounded-lg shadow">
      <div>
        <h2 class="text-3xl font-bold text-center">Video Scanner</h2>
        <p class="mt-2 text-center text-gray-600">
          {{ needsPasswordChange ? 'Set New Password' : 'Sign in to your account' }}
        </p>
      </div>
      
      <form @submit.prevent="handleLogin" class="space-y-6" v-if="!needsPasswordChange">
        <div>
          <label class="block text-sm font-medium text-gray-700">Email</label>
          <input
            v-model="email"
            type="email"
            required
            class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        
        <div>
          <label class="block text-sm font-medium text-gray-700">Password</label>
          <input
            v-model="password"
            type="password"
            required
            class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        <div v-if="error" class="text-red-600 text-sm">{{ error }}</div>

        <button
          type="submit"
          :disabled="loading"
          class="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
        >
          {{ loading ? 'Signing in...' : 'Sign in' }}
        </button>
      </form>

      <form @submit.prevent="handleNewPassword" class="space-y-6" v-else>
        <div>
          <label class="block text-sm font-medium text-gray-700">New Password</label>
          <input
            v-model="newPassword"
            type="password"
            required
            minlength="8"
            class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
          />
          <p class="mt-1 text-xs text-gray-500">Min 8 characters, uppercase, lowercase, number, symbol</p>
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700">Confirm Password</label>
          <input
            v-model="confirmPassword"
            type="password"
            required
            minlength="8"
            class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        <div v-if="error" class="text-red-600 text-sm">{{ error }}</div>

        <button
          type="submit"
          :disabled="loading"
          class="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
        >
          {{ loading ? 'Setting password...' : 'Set Password' }}
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
const { login, completeNewPassword } = useAuth();
const router = useRouter();

const email = ref('');
const password = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const loading = ref(false);
const error = ref('');
const needsPasswordChange = ref(false);
const cognitoUser = ref<any>(null);
const userAttributes = ref<any>(null);

const handleLogin = async () => {
  loading.value = true;
  error.value = '';
  
  try {
    const result = await login(email.value, password.value);
    
    if (result.challengeName === 'NEW_PASSWORD_REQUIRED') {
      needsPasswordChange.value = true;
      cognitoUser.value = result.cognitoUser;
      userAttributes.value = result.userAttributes;
    } else {
      router.push('/dashboard');
    }
  } catch (e: any) {
    error.value = e.message || 'Login failed';
  } finally {
    loading.value = false;
  }
};

const handleNewPassword = async () => {
  if (newPassword.value !== confirmPassword.value) {
    error.value = 'Passwords do not match';
    return;
  }
  
  loading.value = true;
  error.value = '';
  
  try {
    await completeNewPassword(cognitoUser.value, newPassword.value, userAttributes.value);
    router.push('/dashboard');
  } catch (e: any) {
    error.value = e.message || 'Failed to set password';
  } finally {
    loading.value = false;
  }
};
</script>
