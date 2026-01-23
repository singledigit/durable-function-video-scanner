<template>
  <div class="min-h-screen bg-gray-50">
    <nav class="bg-white shadow">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex justify-between h-16">
          <div class="flex items-center">
            <h1 class="text-xl font-bold">Video Scanner</h1>
          </div>
          <div class="flex items-center space-x-4">
            <span class="text-sm text-gray-600"><ClientOnly>{{ user?.username }}</ClientOnly></span>
            <NuxtLink v-if="isAdmin" to="/admin" class="text-blue-600 hover:text-blue-800">Admin</NuxtLink>
            <button @click="handleLogout" class="text-red-600 hover:text-red-800">Logout</button>
          </div>
        </div>
      </div>
    </nav>

    <div class="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
      <div class="px-4 py-6 sm:px-0">
        <div class="mb-6">
          <h2 class="text-2xl font-bold mb-4">Upload Video</h2>
          <input
            type="file"
            accept="video/*"
            @change="handleFileSelect"
            class="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
          />
          <button
            v-if="selectedFile"
            @click="uploadFile"
            :disabled="uploading"
            class="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {{ uploading ? 'Uploading...' : 'Upload' }}
          </button>
        </div>

        <div>
          <h2 class="text-2xl font-bold mb-4">My Scans</h2>
          <div v-if="loading" class="text-gray-600">Loading...</div>
          <div v-else-if="scans.length === 0" class="text-gray-600">No scans yet</div>
          <div v-else class="grid gap-4">
            <div
              v-for="scan in scans"
              :key="scan.scanId"
              class="bg-white p-4 rounded-lg shadow cursor-pointer hover:shadow-lg transition"
              @click="viewScan(scan.scanId)"
            >
              <div class="flex justify-between items-start">
                <div>
                  <h3 class="font-semibold">{{ scan.objectKey.split('/').pop() }}</h3>
                  <p class="text-sm text-gray-600"><ClientOnly>{{ new Date(scan.uploadedAt).toLocaleString() }}</ClientOnly></p>
                </div>
                <span
                  :class="{
                    'bg-green-100 text-green-800': scan.overallAssessment === 'SAFE',
                    'bg-yellow-100 text-yellow-800': scan.overallAssessment === 'CAUTION',
                    'bg-red-100 text-red-800': scan.overallAssessment === 'UNSAFE',
                    'bg-gray-100 text-gray-800': scan.overallAssessment === 'PROCESSING',
                  }"
                  class="px-2 py-1 rounded text-xs font-semibold"
                >
                  {{ scan.overallAssessment }}
                </span>
              </div>
              <div class="mt-2">
                <span
                  :class="{
                    'bg-blue-100 text-blue-800': scan.approvalStatus === 'PENDING_REVIEW',
                    'bg-green-100 text-green-800': scan.approvalStatus === 'APPROVED',
                    'bg-red-100 text-red-800': scan.approvalStatus === 'REJECTED',
                    'bg-gray-100 text-gray-600 animate-pulse': scan.approvalStatus === 'PROCESSING',
                  }"
                  class="px-2 py-1 rounded text-xs"
                >
                  {{ scan.approvalStatus }}
                </span>
              </div>
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
const { uploadVideo, listScans } = useApi();
const router = useRouter();

const scans = ref<any[]>([]);
const loading = ref(true);
const selectedFile = ref<File | null>(null);
const uploading = ref(false);

const loadScans = async () => {
  loading.value = true;
  try {
    const result = await listScans();
    scans.value = result.scans;
  } catch (error) {
    console.error('Failed to load scans:', error);
  } finally {
    loading.value = false;
  }
};

const handleFileSelect = (event: Event) => {
  const target = event.target as HTMLInputElement;
  selectedFile.value = target.files?.[0] || null;
};

const uploadFile = async () => {
  if (!selectedFile.value) return;

  uploading.value = true;
  try {
    const { url, key } = await uploadVideo(selectedFile.value.name, selectedFile.value.type);
    
    await fetch(url, {
      method: 'PUT',
      body: selectedFile.value,
      headers: { 'Content-Type': selectedFile.value.type },
    });

    selectedFile.value = null;
    
    // Add optimistic scan entry
    const optimisticScan = {
      scanId: 'uploading-' + Date.now(),
      objectKey: key,
      uploadedAt: new Date().toISOString(),
      overallAssessment: 'PROCESSING',
      approvalStatus: 'PROCESSING',
      isOptimistic: true
    };
    scans.value = [optimisticScan, ...scans.value];
  } catch (error) {
    console.error('Upload failed:', error);
  } finally {
    uploading.value = false;
  }
};

const viewScan = (scanId: string) => {
  router.push(`/scan/${scanId}`);
};

const handleLogout = async () => {
  await logout();
  router.push('/');
};

// Listen for realtime scan updates
const handleScanUpdate = (event: CustomEvent) => {
  console.log('Received scan update:', event.detail);
  const update = event.detail;
  
  // Find existing scan by scanId
  const existingIndex = scans.value.findIndex(s => s.scanId === update.scanId);
  
  console.log('Existing index:', existingIndex, 'Update scanId:', update.scanId);
  
  if (existingIndex >= 0) {
    // Update existing scan with new status - create new array for reactivity
    const updatedScans = [...scans.value];
    
    // Map event type to approval status
    let approvalStatus = updatedScans[existingIndex].approvalStatus;
    if (update.type === 'PENDING_REVIEW') {
      approvalStatus = 'PENDING_REVIEW';
    } else if (update.type === 'APPROVED') {
      approvalStatus = 'APPROVED';
    } else if (update.type === 'REJECTED') {
      approvalStatus = 'REJECTED';
    } else {
      // Show the actual event type for progress updates
      approvalStatus = update.type;
    }
    
    updatedScans[existingIndex] = {
      ...updatedScans[existingIndex],
      approvalStatus,
      overallAssessment: update.data?.overallAssessment || updatedScans[existingIndex].overallAssessment,
      isOptimistic: false,
    };
    console.log('Updated scan:', updatedScans[existingIndex]);
    scans.value = updatedScans;
  } else if (update.type === 'SCAN_STARTED') {
    // New scan - remove optimistic entry and add real one
    console.log('Adding new scan for SCAN_STARTED');
    scans.value = scans.value.filter(s => !s.isOptimistic);
    scans.value = [{
      scanId: update.scanId,
      objectKey: update.data.objectKey,
      uploadedAt: update.timestamp,
      approvalStatus: 'PROCESSING',
      overallAssessment: 'PROCESSING',
    }, ...scans.value];
  }
};

onMounted(() => {
  loadScans();
  window.addEventListener('scan-update', handleScanUpdate as EventListener);
});

onUnmounted(() => {
  window.removeEventListener('scan-update', handleScanUpdate as EventListener);
});
</script>
