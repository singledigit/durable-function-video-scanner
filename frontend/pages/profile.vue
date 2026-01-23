<template>
  <div class="min-h-screen bg-gray-50">
    <AppNav />

    <div class="max-w-2xl mx-auto py-6 sm:px-6 lg:px-8">
      <div class="bg-white shadow rounded-lg p-6">
        <h2 class="text-2xl font-bold mb-6">Profile</h2>

        <form @submit.prevent="handleSave" class="space-y-6">
          <div>
            <label class="block text-sm font-medium text-gray-700">First Name</label>
            <input
              v-model="profile.firstName"
              type="text"
              required
              class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700">Last Name</label>
            <input
              v-model="profile.lastName"
              type="text"
              required
              class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700">Display Name</label>
            <input
              v-model="profile.displayName"
              type="text"
              required
              class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          <div v-if="error" class="text-red-600 text-sm">{{ error }}</div>
          <div v-if="success" class="text-green-600 text-sm">Profile updated successfully!</div>

          <button
            type="submit"
            :disabled="loading"
            class="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
          >
            {{ loading ? 'Saving...' : 'Save Profile' }}
          </button>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

const { user } = useAuth();
const { updateProfile, getProfile } = useApi();
const router = useRouter();

const profile = ref({
  firstName: '',
  lastName: '',
  displayName: ''
});

const loading = ref(false);
const error = ref('');
const success = ref(false);

onMounted(async () => {
  if (!user.value) {
    router.push('/');
    return;
  }

  try {
    const data = await getProfile();
    if (data) {
      profile.value = data;
    }
  } catch (e) {
    console.error('Failed to load profile:', e);
  }
});

const handleSave = async () => {
  loading.value = true;
  error.value = '';
  success.value = false;

  try {
    await updateProfile(profile.value);
    success.value = true;
    setTimeout(() => success.value = false, 3000);
  } catch (e: any) {
    error.value = e.message || 'Failed to update profile';
  } finally {
    loading.value = false;
  }
};
</script>
