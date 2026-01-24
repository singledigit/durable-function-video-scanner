<template>
  <div class="min-h-screen bg-gray-50">
    <AppNav />

    <div class="max-w-4xl mx-auto py-6 sm:px-6 lg:px-8">
      <!-- Invite User Form -->
      <div class="bg-white shadow rounded-lg p-6 mb-6">
        <h2 class="text-xl font-bold mb-4">Invite New User</h2>
        
        <form @submit.prevent="handleInvite" class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700">Email Address</label>
            <input
              v-model="inviteEmail"
              type="email"
              required
              class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          <div v-if="error" class="text-red-600 text-sm">{{ error }}</div>
          <div v-if="success" class="text-green-600 text-sm">{{ success }}</div>

          <button
            type="submit"
            :disabled="loading"
            class="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
          >
            {{ loading ? 'Sending invitation...' : 'Send Invitation' }}
          </button>
        </form>
      </div>

      <!-- Users List -->
      <div class="bg-white shadow rounded-lg p-6">
        <h2 class="text-xl font-bold mb-4">Users</h2>
        
        <div v-if="loadingUsers" class="text-center py-4">Loading users...</div>
        
        <div v-else class="space-y-2">
          <div 
            v-for="user in users" 
            :key="user.username"
            class="flex items-center justify-between p-3 border border-gray-200 rounded-md"
          >
            <div>
              <div class="font-medium">{{ user.email }}</div>
              <div class="text-sm text-gray-500">{{ user.status }}</div>
            </div>
            <button
              @click="handleDelete(user.username)"
              class="text-red-600 hover:text-red-800 text-sm"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

const { isAdmin } = useAuth();
const { inviteUser, listUsers, deleteUser } = useApi();
const router = useRouter();

const inviteEmail = ref('');
const loading = ref(false);
const error = ref('');
const success = ref('');
const users = ref<any[]>([]);
const loadingUsers = ref(true);

onMounted(async () => {
  if (!isAdmin.value) {
    router.push('/dashboard');
    return;
  }
  
  await loadUsers();
});

const loadUsers = async () => {
  loadingUsers.value = true;
  try {
    users.value = await listUsers();
  } catch (e) {
    // Handle error silently
    error.value = 'Failed to load users. The API endpoint may not be deployed yet.';
  } finally {
    loadingUsers.value = false;
  }
};

const handleInvite = async () => {
  loading.value = true;
  error.value = '';
  success.value = '';

  try {
    await inviteUser(inviteEmail.value);
    success.value = `Invitation sent to ${inviteEmail.value}`;
    inviteEmail.value = '';
    await loadUsers();
    setTimeout(() => success.value = '', 3000);
  } catch (e: any) {
    error.value = e.message || 'Failed to send invitation';
  } finally {
    loading.value = false;
  }
};

const handleDelete = async (username: string) => {
  if (!confirm('Are you sure you want to delete this user?')) return;

  try {
    await deleteUser(username);
    await loadUsers();
  } catch (e: any) {
    error.value = e.message || 'Failed to delete user';
  }
};
</script>
