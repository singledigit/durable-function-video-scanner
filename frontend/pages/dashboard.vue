<template>
  <div class="min-h-screen bg-gray-50">
    <AppNav />

    <div class="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
      <div class="px-4 py-6 sm:px-0">
        <div class="mb-6">
          <h2 class="text-2xl font-bold mb-4">Upload Videos</h2>
          
          <!-- Drag and Drop Zone -->
          <div
            @drop.prevent="handleDrop"
            @dragover.prevent="isDragging = true"
            @dragleave.prevent="isDragging = false"
            :class="{
              'border-blue-500 bg-blue-50': isDragging,
              'border-gray-300': !isDragging
            }"
            class="border-2 border-dashed rounded-lg p-8 text-center transition-colors"
          >
            <div class="space-y-2">
              <svg class="mx-auto h-12 w-12 text-gray-400" stroke="currentColor" fill="none" viewBox="0 0 48 48">
                <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <div class="text-gray-600">
                <label class="cursor-pointer text-blue-600 hover:text-blue-700">
                  <span>Click to select</span>
                  <input
                    type="file"
                    accept="video/*"
                    multiple
                    @change="handleFileSelect"
                    class="hidden"
                  />
                </label>
                <span> or drag and drop videos here</span>
              </div>
              <p class="text-xs text-gray-500">MP4, MOV, AVI up to 100MB each</p>
            </div>
          </div>

          <!-- Selected Files List -->
          <div v-if="selectedFiles.length > 0" class="mt-4">
            <div class="flex justify-between items-center mb-2">
              <h3 class="font-semibold">Selected Files ({{ selectedFiles.length }})</h3>
              <button
                @click="selectedFiles = []"
                class="text-sm text-red-600 hover:text-red-700"
              >
                Clear All
              </button>
            </div>
            <div class="space-y-2 max-h-40 overflow-y-auto">
              <div
                v-for="(file, index) in selectedFiles"
                :key="index"
                class="flex items-center justify-between bg-gray-50 p-2 rounded"
              >
                <span class="text-sm truncate flex-1">{{ file.name }}</span>
                <button
                  @click="removeFile(index)"
                  class="ml-2 text-red-600 hover:text-red-700"
                >
                  ×
                </button>
              </div>
            </div>
            <button
              @click="uploadFiles"
              :disabled="uploading"
              class="mt-4 w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400"
            >
              {{ uploading ? 'Uploading...' : `Upload ${selectedFiles.length} Video${selectedFiles.length > 1 ? 's' : ''}` }}
            </button>
          </div>
        </div>

        <div>
          <h2 class="text-2xl font-bold mb-4">My Scans</h2>
          <div v-if="loading" class="text-gray-600">Loading...</div>
          <div v-else-if="scans.length === 0" class="text-gray-600">No scans yet</div>
          <div v-else class="grid gap-4">
            <div
              v-for="scan in scans"
              :key="scan.scanId"
              class="bg-white p-4 rounded-lg shadow hover:shadow-lg transition"
            >
              <div class="flex justify-between items-start mb-4">
                <div class="flex-1">
                  <h3 class="font-semibold">{{ scan.objectKey.split('/').pop() }}</h3>
                  <p class="text-sm text-gray-600"><ClientOnly>{{ new Date(scan.uploadedAt).toLocaleString() }}</ClientOnly></p>
                  
                  <!-- Status Progress Indicator -->
                  <div class="flex items-center gap-2 mt-2">
                    <!-- Completed steps as dots -->
                    <div
                      v-for="status in getCompletedStatuses(scan)"
                      :key="status"
                      :class="getStatusColor(status)"
                      class="w-2 h-2 rounded-full"
                      :title="formatStatus(status)"
                    ></div>
                    
                    <!-- Current status as badge -->
                    <span
                      :class="getStatusBadgeClass(scan.approvalStatus)"
                      class="px-2 py-1 rounded text-xs font-medium"
                    >
                      {{ formatStatus(scan.approvalStatus) }}
                    </span>
                  </div>
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

              <div class="flex gap-2">
                <button
                  @click="viewScan(scan.scanId)"
                  class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  View Details
                </button>
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

const { uploadVideo, listScans } = useApi();

const scans = ref<any[]>([]);
const loading = ref(true);
const selectedFiles = ref<File[]>([]);
const uploading = ref(false);
const isDragging = ref(false);

onMounted(async () => {
  await loadScans();
});

// Status progression order
const statusOrder = [
  'PROCESSING',
  'SCAN_STARTED',
  'TRANSCRIPTION_COMPLETED',
  'REKOGNITION_COMPLETED',
  'ANALYSIS_COMPLETED',
  'REPORT_GENERATED',
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED'
];

// Format status for display
const formatStatus = (status: string) => {
  return status
    .toLowerCase()
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

// Get completed statuses (all before current)
const getCompletedStatuses = (scan: any) => {
  const currentIndex = statusOrder.indexOf(scan.approvalStatus);
  if (currentIndex <= 0) return [];
  return statusOrder.slice(1, currentIndex); // Skip PROCESSING
};

// Get color class for status dot
const getStatusColor = (status: string) => {
  const colors: Record<string, string> = {
    'SCAN_STARTED': 'bg-blue-500',
    'TRANSCRIPTION_COMPLETED': 'bg-purple-500',
    'REKOGNITION_COMPLETED': 'bg-indigo-500',
    'ANALYSIS_COMPLETED': 'bg-cyan-500',
    'REPORT_GENERATED': 'bg-teal-500',
    'PENDING_REVIEW': 'bg-yellow-500',
    'APPROVED': 'bg-green-500',
    'REJECTED': 'bg-red-500'
  };
  return colors[status] || 'bg-gray-500';
};

// Get badge class for current status
const getStatusBadgeClass = (status: string) => {
  const classes: Record<string, string> = {
    'PROCESSING': 'bg-gray-100 text-gray-600 animate-pulse',
    'SCAN_STARTED': 'bg-blue-100 text-blue-800',
    'TRANSCRIPTION_COMPLETED': 'bg-purple-100 text-purple-800',
    'REKOGNITION_COMPLETED': 'bg-indigo-100 text-indigo-800',
    'ANALYSIS_COMPLETED': 'bg-cyan-100 text-cyan-800',
    'REPORT_GENERATED': 'bg-teal-100 text-teal-800',
    'PENDING_REVIEW': 'bg-yellow-100 text-yellow-800',
    'APPROVED': 'bg-green-100 text-green-800',
    'REJECTED': 'bg-red-100 text-red-800'
  };
  return classes[status] || 'bg-gray-100 text-gray-600';
};

const loadScans = async () => {
  loading.value = true;
  try {
    const result = await listScans();
    scans.value = result.scans;
  } catch (error) {
    // Handle error silently
  } finally {
    loading.value = false;
  }
};

const handleFileSelect = (event: Event) => {
  const target = event.target as HTMLInputElement;
  if (target.files) {
    selectedFiles.value = Array.from(target.files);
  }
};

const handleDrop = (event: DragEvent) => {
  isDragging.value = false;
  if (event.dataTransfer?.files) {
    const videoFiles = Array.from(event.dataTransfer.files).filter(file => 
      file.type.startsWith('video/')
    );
    selectedFiles.value = videoFiles;
  }
};

const removeFile = (index: number) => {
  selectedFiles.value = selectedFiles.value.filter((_, i) => i !== index);
};

const uploadFiles = async () => {
  if (selectedFiles.value.length === 0) return;

  uploading.value = true;
  try {
    // Upload all files in parallel
    await Promise.all(
      selectedFiles.value.map(async (file) => {
        const { url, key } = await uploadVideo(file.name, file.type);
        
        await fetch(url, {
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': file.type },
        });

        // Add optimistic scan entry
        const optimisticScan = {
          scanId: 'uploading-' + Date.now() + '-' + Math.random(),
          objectKey: key,
          uploadedAt: new Date().toISOString(),
          overallAssessment: 'PROCESSING',
          approvalStatus: 'PROCESSING',
          isOptimistic: true
        };
        scans.value = [optimisticScan, ...scans.value];
      })
    );

    selectedFiles.value = [];
  } catch (error) {
    // Handle error silently
  } finally {
    uploading.value = false;
  }
};

const viewScan = (scanId: string) => {
  navigateTo(`/scan/${scanId}`);
};

// Listen for realtime scan updates
const handleScanUpdate = (event: CustomEvent) => {
  const update = event.detail;
  
  // Find existing scan by scanId
  const existingIndex = scans.value.findIndex(s => s.scanId === update.scanId);
  
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
    scans.value = updatedScans;
  } else if (update.type === 'SCAN_STARTED') {
    // New scan - remove optimistic entry and add real one
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
