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
                  
                  <!-- Status Progress Indicator with Parallel Flow -->
                  <div class="mt-3">
                    <div class="flex items-center gap-1">
                      <!-- Sequential steps before parallel -->
                      <div
                        v-if="hasStatus(scan, 'SCAN_STARTED')"
                        :class="getStatusColor('SCAN_STARTED')"
                        class="w-3 h-3 rounded-full flex-shrink-0"
                        :title="formatStatus('SCAN_STARTED')"
                      ></div>
                      <div v-if="hasStatus(scan, 'SCAN_STARTED')" class="w-3 h-px bg-gray-300"></div>
                      
                      <!-- Parallel branch indicator -->
                      <div v-if="hasStatus(scan, 'TRANSCRIPTION_STARTED') || hasStatus(scan, 'REKOGNITION_STARTED')" class="flex items-center">
                        <!-- Fork point -->
                        <div class="w-1.5 h-1.5 rounded-full bg-gray-400 flex-shrink-0"></div>
                        
                        <!-- Parallel branches container - always show both branches once parallel starts -->
                        <div class="flex flex-col gap-0.5 ml-1">
                          <!-- Top branch: Transcription -->
                          <div class="flex items-center gap-1">
                            <div class="w-2 h-px bg-gray-300 self-center"></div>
                            <div
                              :class="hasStatus(scan, 'TRANSCRIPTION_STARTED') ? getStatusColor('TRANSCRIPTION_STARTED') : 'bg-gray-200'"
                              class="w-2.5 h-2.5 rounded-full flex-shrink-0"
                              :title="hasStatus(scan, 'TRANSCRIPTION_STARTED') ? 'Transcription Running' : 'Transcription Pending'"
                            ></div>
                            <div class="w-2 h-px self-center" :class="hasStatus(scan, 'TRANSCRIPTION_STARTED') ? 'bg-gray-300' : 'bg-gray-200'"></div>
                            <div
                              :class="hasStatus(scan, 'TRANSCRIPTION_COMPLETED') ? getStatusColor('TRANSCRIPTION_COMPLETED') : 'bg-gray-200'"
                              class="w-2.5 h-2.5 rounded-full flex-shrink-0"
                              :title="hasStatus(scan, 'TRANSCRIPTION_COMPLETED') ? 'Transcription Done' : 'Waiting'"
                            ></div>
                          </div>
                          
                          <!-- Bottom branch: Rekognition -->
                          <div class="flex items-center gap-1">
                            <div class="w-2 h-px bg-gray-300 self-center"></div>
                            <div
                              :class="hasStatus(scan, 'REKOGNITION_STARTED') ? getStatusColor('REKOGNITION_STARTED') : 'bg-gray-200'"
                              class="w-2.5 h-2.5 rounded-full flex-shrink-0"
                              :title="hasStatus(scan, 'REKOGNITION_STARTED') ? 'Rekognition Running' : 'Rekognition Pending'"
                            ></div>
                            <div class="w-2 h-px self-center" :class="hasStatus(scan, 'REKOGNITION_STARTED') ? 'bg-gray-300' : 'bg-gray-200'"></div>
                            <div
                              :class="hasStatus(scan, 'REKOGNITION_COMPLETED') ? getStatusColor('REKOGNITION_COMPLETED') : 'bg-gray-200'"
                              class="w-2.5 h-2.5 rounded-full flex-shrink-0"
                              :title="hasStatus(scan, 'REKOGNITION_COMPLETED') ? 'Rekognition Done' : 'Waiting'"
                            ></div>
                          </div>
                        </div>
                        
                        <!-- Merge point -->
                        <div v-if="hasStatus(scan, 'BUILDING_CORPUS')" class="flex items-center ml-1">
                          <div class="w-1.5 h-1.5 rounded-full bg-gray-400 flex-shrink-0"></div>
                          <div class="w-3 h-px bg-gray-300"></div>
                        </div>
                      </div>
                      
                      <!-- Sequential steps after parallel -->
                      <div
                        v-if="hasStatus(scan, 'BUILDING_CORPUS')"
                        :class="getStatusColor('BUILDING_CORPUS')"
                        class="w-3 h-3 rounded-full flex-shrink-0"
                        :title="formatStatus('BUILDING_CORPUS')"
                      ></div>
                      <div v-if="hasStatus(scan, 'BUILDING_CORPUS')" class="w-3 h-px bg-gray-300"></div>
                      
                      <div
                        v-if="hasStatus(scan, 'ANALYSIS_STARTING')"
                        :class="getStatusColor('ANALYSIS_STARTING')"
                        class="w-3 h-3 rounded-full flex-shrink-0"
                        :title="formatStatus('ANALYSIS_STARTING')"
                      ></div>
                      <div v-if="hasStatus(scan, 'ANALYSIS_STARTING')" class="w-3 h-px bg-gray-300"></div>
                      
                      <!-- Analysis parallel branch indicator (3 branches) -->
                      <div v-if="hasStatus(scan, 'TOXICITY_STARTED') || hasStatus(scan, 'SENTIMENT_STARTED') || hasStatus(scan, 'PII_STARTED')" class="flex items-center">
                        <!-- Fork point -->
                        <div class="w-1.5 h-1.5 rounded-full bg-gray-400 flex-shrink-0"></div>
                        
                        <!-- Parallel branches container - 3 branches for analysis -->
                        <div class="flex flex-col gap-0.5 ml-1">
                          <!-- Top branch: Toxicity -->
                          <div class="flex items-center gap-1">
                            <div class="w-2 h-px bg-gray-300 self-center"></div>
                            <div
                              :class="hasStatus(scan, 'TOXICITY_STARTED') ? getStatusColor('TOXICITY_STARTED') : 'bg-gray-200'"
                              class="w-2.5 h-2.5 rounded-full flex-shrink-0"
                              :title="hasStatus(scan, 'TOXICITY_STARTED') ? 'Toxicity Running' : 'Toxicity Pending'"
                            ></div>
                            <div class="w-2 h-px self-center" :class="hasStatus(scan, 'TOXICITY_STARTED') ? 'bg-gray-300' : 'bg-gray-200'"></div>
                            <div
                              :class="hasStatus(scan, 'TOXICITY_COMPLETED') ? getStatusColor('TOXICITY_COMPLETED') : 'bg-gray-200'"
                              class="w-2.5 h-2.5 rounded-full flex-shrink-0"
                              :title="hasStatus(scan, 'TOXICITY_COMPLETED') ? 'Toxicity Done' : 'Waiting'"
                            ></div>
                          </div>
                          
                          <!-- Middle branch: Sentiment -->
                          <div class="flex items-center gap-1">
                            <div class="w-2 h-px bg-gray-300 self-center"></div>
                            <div
                              :class="hasStatus(scan, 'SENTIMENT_STARTED') ? getStatusColor('SENTIMENT_STARTED') : 'bg-gray-200'"
                              class="w-2.5 h-2.5 rounded-full flex-shrink-0"
                              :title="hasStatus(scan, 'SENTIMENT_STARTED') ? 'Sentiment Running' : 'Sentiment Pending'"
                            ></div>
                            <div class="w-2 h-px self-center" :class="hasStatus(scan, 'SENTIMENT_STARTED') ? 'bg-gray-300' : 'bg-gray-200'"></div>
                            <div
                              :class="hasStatus(scan, 'SENTIMENT_COMPLETED') ? getStatusColor('SENTIMENT_COMPLETED') : 'bg-gray-200'"
                              class="w-2.5 h-2.5 rounded-full flex-shrink-0"
                              :title="hasStatus(scan, 'SENTIMENT_COMPLETED') ? 'Sentiment Done' : 'Waiting'"
                            ></div>
                          </div>
                          
                          <!-- Bottom branch: PII -->
                          <div class="flex items-center gap-1">
                            <div class="w-2 h-px bg-gray-300 self-center"></div>
                            <div
                              :class="hasStatus(scan, 'PII_STARTED') ? getStatusColor('PII_STARTED') : 'bg-gray-200'"
                              class="w-2.5 h-2.5 rounded-full flex-shrink-0"
                              :title="hasStatus(scan, 'PII_STARTED') ? 'PII Running' : 'PII Pending'"
                            ></div>
                            <div class="w-2 h-px self-center" :class="hasStatus(scan, 'PII_STARTED') ? 'bg-gray-300' : 'bg-gray-200'"></div>
                            <div
                              :class="hasStatus(scan, 'PII_COMPLETED') ? getStatusColor('PII_COMPLETED') : 'bg-gray-200'"
                              class="w-2.5 h-2.5 rounded-full flex-shrink-0"
                              :title="hasStatus(scan, 'PII_COMPLETED') ? 'PII Done' : 'Waiting'"
                            ></div>
                          </div>
                        </div>
                        
                        <!-- Merge point -->
                        <div v-if="hasStatus(scan, 'ANALYSIS_COMPLETED')" class="flex items-center ml-1">
                          <div class="w-1.5 h-1.5 rounded-full bg-gray-400 flex-shrink-0"></div>
                          <div class="w-3 h-px bg-gray-300"></div>
                        </div>
                      </div>
                      
                      <div
                        v-if="hasStatus(scan, 'ANALYSIS_COMPLETED')"
                        :class="getStatusColor('ANALYSIS_COMPLETED')"
                        class="w-3 h-3 rounded-full flex-shrink-0"
                        :title="formatStatus('ANALYSIS_COMPLETED')"
                      ></div>
                      <div v-if="hasStatus(scan, 'ANALYSIS_COMPLETED')" class="w-3 h-px bg-gray-300"></div>
                      
                      <div
                        v-if="hasStatus(scan, 'GENERATING_SUMMARY')"
                        :class="getStatusColor('GENERATING_SUMMARY')"
                        class="w-3 h-3 rounded-full flex-shrink-0"
                        :title="formatStatus('GENERATING_SUMMARY')"
                      ></div>
                      <div v-if="hasStatus(scan, 'GENERATING_SUMMARY')" class="w-3 h-px bg-gray-300"></div>
                      
                      <div
                        v-if="hasStatus(scan, 'REPORT_GENERATED')"
                        :class="getStatusColor('REPORT_GENERATED')"
                        class="w-3 h-3 rounded-full flex-shrink-0"
                        :title="formatStatus('REPORT_GENERATED')"
                      ></div>
                      
                      <!-- Current status badge(s) move with progress -->
                      <div class="ml-3">
                        <!-- Show both parallel statuses when active during transcription/rekognition, stacked to match branches -->
                        <template v-if="hasStatus(scan, 'TRANSCRIPTION_STARTED') && !hasStatus(scan, 'BUILDING_CORPUS')">
                          <div class="flex flex-col gap-0.5">
                            <span
                              v-if="!hasStatus(scan, 'TRANSCRIPTION_COMPLETED')"
                              :class="getStatusBadgeClass('TRANSCRIPTION_STARTED')"
                              class="px-2 py-0.5 rounded text-xs font-medium inline-block"
                            >
                              {{ formatStatus('TRANSCRIPTION_STARTED') }}
                            </span>
                            <span
                              v-if="hasStatus(scan, 'REKOGNITION_STARTED') && !hasStatus(scan, 'REKOGNITION_COMPLETED')"
                              :class="getStatusBadgeClass('REKOGNITION_STARTED')"
                              class="px-2 py-0.5 rounded text-xs font-medium inline-block"
                            >
                              {{ formatStatus('REKOGNITION_STARTED') }}
                            </span>
                          </div>
                        </template>
                        <!-- Show 3 parallel statuses when active during analysis, stacked to match branches -->
                        <template v-else-if="hasStatus(scan, 'TOXICITY_STARTED') && !hasStatus(scan, 'ANALYSIS_COMPLETED')">
                          <div class="flex flex-col gap-0.5">
                            <span
                              v-if="!hasStatus(scan, 'TOXICITY_COMPLETED')"
                              :class="getStatusBadgeClass('TOXICITY_STARTED')"
                              class="px-2 py-0.5 rounded text-xs font-medium inline-block"
                            >
                              {{ formatStatus('TOXICITY_STARTED') }}
                            </span>
                            <span
                              v-if="hasStatus(scan, 'SENTIMENT_STARTED') && !hasStatus(scan, 'SENTIMENT_COMPLETED')"
                              :class="getStatusBadgeClass('SENTIMENT_STARTED')"
                              class="px-2 py-0.5 rounded text-xs font-medium inline-block"
                            >
                              {{ formatStatus('SENTIMENT_STARTED') }}
                            </span>
                            <span
                              v-if="hasStatus(scan, 'PII_STARTED') && !hasStatus(scan, 'PII_COMPLETED')"
                              :class="getStatusBadgeClass('PII_STARTED')"
                              class="px-2 py-0.5 rounded text-xs font-medium inline-block"
                            >
                              {{ formatStatus('PII_STARTED') }}
                            </span>
                          </div>
                        </template>
                        <!-- Show single status for non-parallel steps -->
                        <span
                          v-else
                          :class="getStatusBadgeClass(scan.approvalStatus)"
                          class="px-2 py-1 rounded text-xs font-medium inline-block"
                        >
                          {{ formatStatus(scan.approvalStatus) }}
                        </span>
                      </div>
                    </div>
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
  'TRANSCRIPTION_STARTED',
  'TRANSCRIPTION_COMPLETED',
  'REKOGNITION_STARTED',
  'REKOGNITION_COMPLETED',
  'BUILDING_CORPUS',
  'ANALYSIS_STARTING',
  'TOXICITY_STARTED',
  'TOXICITY_COMPLETED',
  'SENTIMENT_STARTED',
  'SENTIMENT_COMPLETED',
  'PII_STARTED',
  'PII_COMPLETED',
  'ANALYSIS_COMPLETED',
  'GENERATING_SUMMARY',
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
    'TRANSCRIPTION_STARTED': 'bg-purple-400',
    'TRANSCRIPTION_COMPLETED': 'bg-purple-600',
    'REKOGNITION_STARTED': 'bg-indigo-400',
    'REKOGNITION_COMPLETED': 'bg-indigo-600',
    'BUILDING_CORPUS': 'bg-violet-500',
    'ANALYSIS_STARTING': 'bg-cyan-500',
    'TOXICITY_STARTED': 'bg-orange-400',
    'TOXICITY_COMPLETED': 'bg-orange-600',
    'SENTIMENT_STARTED': 'bg-emerald-400',
    'SENTIMENT_COMPLETED': 'bg-emerald-600',
    'PII_STARTED': 'bg-rose-400',
    'PII_COMPLETED': 'bg-rose-600',
    'ANALYSIS_COMPLETED': 'bg-cyan-600',
    'GENERATING_SUMMARY': 'bg-teal-400',
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
    'TRANSCRIPTION_STARTED': 'bg-purple-100 text-purple-700 animate-pulse',
    'TRANSCRIPTION_COMPLETED': 'bg-purple-100 text-purple-800',
    'REKOGNITION_STARTED': 'bg-indigo-100 text-indigo-700 animate-pulse',
    'REKOGNITION_COMPLETED': 'bg-indigo-100 text-indigo-800',
    'BUILDING_CORPUS': 'bg-violet-100 text-violet-800 animate-pulse',
    'ANALYSIS_STARTING': 'bg-cyan-100 text-cyan-800',
    'TOXICITY_STARTED': 'bg-orange-100 text-orange-700 animate-pulse',
    'TOXICITY_COMPLETED': 'bg-orange-100 text-orange-800',
    'SENTIMENT_STARTED': 'bg-emerald-100 text-emerald-700 animate-pulse',
    'SENTIMENT_COMPLETED': 'bg-emerald-100 text-emerald-800',
    'PII_STARTED': 'bg-rose-100 text-rose-700 animate-pulse',
    'PII_COMPLETED': 'bg-rose-100 text-rose-800',
    'ANALYSIS_COMPLETED': 'bg-cyan-100 text-cyan-800',
    'GENERATING_SUMMARY': 'bg-teal-100 text-teal-700 animate-pulse',
    'REPORT_GENERATED': 'bg-teal-100 text-teal-800',
    'PENDING_REVIEW': 'bg-yellow-100 text-yellow-800',
    'APPROVED': 'bg-green-100 text-green-800',
    'REJECTED': 'bg-red-100 text-red-800'
  };
  return classes[status] || 'bg-gray-100 text-gray-600';
};

const hasStatus = (scan: any, status: string) => {
  // Check if this specific status has been reached
  if (!scan.statusHistory) {
    scan.statusHistory = [];
  }
  const result = scan.statusHistory.includes(status);
  if (status === 'TRANSCRIPTION_STARTED' || status === 'REKOGNITION_STARTED') {
    console.log(`[hasStatus] Checking ${status} for scan ${scan.scanId?.substring(0, 8)}:`, result, 'History:', scan.statusHistory);
  }
  return result;
};

const loadScans = async () => {
  loading.value = true;
  try {
    const result = await listScans();
    // Populate statusHistory for each scan based on their current status
    scans.value = result.scans.map((scan: any) => {
      if (!scan.statusHistory) {
        // Build history from current status - assume all previous statuses were reached
        const currentIndex = statusOrder.indexOf(scan.approvalStatus);
        scan.statusHistory = currentIndex >= 0 ? statusOrder.slice(1, currentIndex + 1) : [];
      }
      return scan;
    });
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
  console.log('[Dashboard] Received scan update:', update.type, 'for scan:', update.scanId);
  
  // Find existing scan by scanId
  const existingIndex = scans.value.findIndex(s => s.scanId === update.scanId);
  
  if (existingIndex >= 0) {
    // Update existing scan with new status - create new array for reactivity
    const updatedScans = [...scans.value];
    const currentScan = updatedScans[existingIndex];
    
    // Initialize statusHistory if it doesn't exist
    if (!currentScan.statusHistory) {
      currentScan.statusHistory = [];
    }
    
    // Add this status to history if not already present
    if (!currentScan.statusHistory.includes(update.type)) {
      currentScan.statusHistory = [
        ...currentScan.statusHistory,
        update.type
      ];
      console.log('[Dashboard] Updated statusHistory:', currentScan.statusHistory);
    }
    
    // Map event type to approval status
    let approvalStatus = currentScan.approvalStatus;
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
    
    // Create completely new object for reactivity
    updatedScans[existingIndex] = {
      ...currentScan,
      statusHistory: [...currentScan.statusHistory], // Force new array reference
      approvalStatus,
      overallAssessment: update.data?.overallAssessment || currentScan.overallAssessment,
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
      statusHistory: ['SCAN_STARTED'],
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
