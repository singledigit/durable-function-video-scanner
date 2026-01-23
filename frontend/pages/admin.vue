<template>
  <div class="min-h-screen bg-gray-50">
    <nav class="bg-white shadow">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex justify-between h-16">
          <div class="flex items-center">
            <h1 class="text-xl font-bold">Admin - Pending Reviews</h1>
          </div>
          <div class="flex items-center space-x-4">
            <NuxtLink to="/dashboard" class="text-blue-600 hover:text-blue-800">Dashboard</NuxtLink>
            <button @click="handleLogout" class="text-red-600 hover:text-red-800">Logout</button>
          </div>
        </div>
      </div>
    </nav>

    <div class="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
      <div class="px-4 py-6 sm:px-0">
        <div v-if="loading" class="text-gray-600">Loading...</div>
        <div v-else-if="pendingScans.length === 0" class="text-gray-600">No pending reviews</div>
        <div v-else class="grid gap-4">
          <div
            v-for="scan in pendingScans"
            :key="scan.scanId"
            class="bg-white p-6 rounded-lg shadow hover:shadow-lg transition"
          >
            <div class="flex justify-between items-start mb-4">
              <div>
                <h3 class="font-semibold text-lg">{{ scan.objectKey.split('/').pop() }}</h3>
                <p class="text-sm text-gray-600">User: {{ scan.userId }}</p>
                <p class="text-sm text-gray-600"><ClientOnly>{{ new Date(scan.uploadedAt).toLocaleString() }}</ClientOnly></p>
              </div>
              <span
                :class="{
                  'bg-green-100 text-green-800': scan.overallAssessment === 'SAFE',
                  'bg-yellow-100 text-yellow-800': scan.overallAssessment === 'CAUTION',
                  'bg-red-100 text-red-800': scan.overallAssessment === 'UNSAFE',
                }"
                class="px-3 py-1 rounded text-sm font-semibold"
              >
                {{ scan.overallAssessment }}
              </span>
            </div>

            <div v-if="scan.aiSummary" class="mb-4 p-3 bg-gray-50 rounded text-sm">
              {{ scan.aiSummary }}
            </div>

            <div class="flex gap-2">
              <button
                @click="viewDetails(scan.scanId)"
                class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                View Details
              </button>
              <button
                @click="approve(scan.scanId)"
                class="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
              >
                Approve
              </button>
              <button
                @click="reject(scan.scanId)"
                class="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
              >
                Reject
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ middleware: 'auth' });

const { user, isAdmin, logout } = useAuth();
const { listPending, approveScan } = useApi();
const router = useRouter();

// Redirect if not admin
if (!isAdmin.value) {
  router.push('/dashboard');
}

const pendingScans = ref<any[]>([]);
const loading = ref(true);

const loadPending = async () => {
  loading.value = true;
  try {
    const result = await listPending();
    pendingScans.value = result.scans;
  } catch (error) {
    console.error('Failed to load pending scans:', error);
  } finally {
    loading.value = false;
  }
};

const viewDetails = (scanId: string) => {
  router.push(`/scan/${scanId}`);
};

const approve = async (scanId: string) => {
  try {
    // Optimistically remove from list
    pendingScans.value = pendingScans.value.filter(s => s.scanId !== scanId);
    await approveScan(scanId, true, 'Approved by admin');
  } catch (error) {
    console.error('Failed to approve:', error);
    // Reload on error to restore the scan
    await loadPending();
  }
};

const reject = async (scanId: string) => {
  const comments = prompt('Rejection reason (optional):');
  try {
    // Optimistically remove from list
    pendingScans.value = pendingScans.value.filter(s => s.scanId !== scanId);
    await approveScan(scanId, false, comments || 'Rejected by admin');
  } catch (error) {
    console.error('Failed to reject:', error);
    // Reload on error to restore the scan
    await loadPending();
  }
};

const handleLogout = async () => {
  await logout();
  router.push('/');
};

// Listen for realtime scan updates
const handleScanUpdate = (event: CustomEvent) => {
  console.log('[Admin] Received scan update:', event.detail);
  const update = event.detail;
  
  // Remove from pending list if approved or rejected
  if (update.type === 'APPROVED' || update.type === 'REJECTED') {
    pendingScans.value = pendingScans.value.filter(s => s.scanId !== update.scanId);
  } else if (update.type === 'PENDING_REVIEW') {
    // Refresh to get new pending scan
    loadPending();
  }
};

const handleAdminPendingReview = (event: CustomEvent) => {
  console.log('[Admin] Received pending review:', event.detail);
  loadPending(); // Refresh pending list
};

onMounted(() => {
  loadPending();
  window.addEventListener('scan-update', handleScanUpdate as EventListener);
  window.addEventListener('admin-pending-review', handleAdminPendingReview as EventListener);
});

onUnmounted(() => {
  window.removeEventListener('scan-update', handleScanUpdate as EventListener);
  window.removeEventListener('admin-pending-review', handleAdminPendingReview as EventListener);
});
</script>
