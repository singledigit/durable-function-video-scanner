<template>
  <div class="min-h-screen bg-gray-50">
    <nav class="bg-white shadow">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div class="flex justify-between h-16">
          <div class="flex items-center">
            <h1 class="text-xl font-bold">Scan Details</h1>
          </div>
          <div class="flex items-center space-x-4">
            <button @click="goBack" class="text-blue-600 hover:text-blue-800">Back</button>
          </div>
        </div>
      </div>
    </nav>

    <div class="max-w-4xl mx-auto py-6 sm:px-6 lg:px-8">
      <div class="px-4 py-6 sm:px-0">
        <div v-if="loading" class="text-gray-600">Loading...</div>
        <div v-else-if="!scan" class="text-gray-600">Scan not found</div>
        <div v-else class="bg-white p-6 rounded-lg shadow">
          <div class="mb-6">
            <h2 class="text-2xl font-bold mb-2">{{ scan.objectKey.split('/').pop() }}</h2>
            <div class="flex gap-2 mb-4">
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
              <span
                :class="{
                  'bg-blue-100 text-blue-800': scan.approvalStatus === 'PENDING_REVIEW',
                  'bg-green-100 text-green-800': scan.approvalStatus === 'APPROVED',
                  'bg-red-100 text-red-800': scan.approvalStatus === 'REJECTED',
                }"
                class="px-3 py-1 rounded text-sm"
              >
                {{ scan.approvalStatus }}
              </span>
            </div>
          </div>

          <!-- Video Player -->
          <div class="mb-6">
            <VideoPlayer :video-url="videoUrl" />
          </div>

          <div class="space-y-4">
            <div>
              <h3 class="font-semibold mb-2">Details</h3>
              <p class="text-sm text-gray-600">User: {{ scan.userId }}</p>
              <p class="text-sm text-gray-600"><ClientOnly>Uploaded: {{ new Date(scan.uploadedAt).toLocaleString() }}</ClientOnly></p>
            </div>

            <div v-if="scan.aiSummary">
              <h3 class="font-semibold mb-2">Summary</h3>
              <div class="text-sm text-gray-700 p-3 bg-gray-50 rounded prose prose-sm max-w-none" v-html="renderMarkdown(scan.aiSummary.replace(/^###?\s*Executive Summary\s*/i, ''))"></div>
            </div>

            <div v-if="scan.reviewedBy">
              <h3 class="font-semibold mb-2">Review Information</h3>
              <p class="text-sm text-gray-600">Reviewed by: {{ scan.reviewedBy }}</p>
              <p class="text-sm text-gray-600"><ClientOnly>Reviewed at: {{ new Date(scan.reviewedAt).toLocaleString() }}</ClientOnly></p>
              <p v-if="scan.reviewComments" class="text-sm text-gray-600">Comments: {{ scan.reviewComments }}</p>
            </div>
          </div>

          <div v-if="scan.approvalStatus === 'PENDING_REVIEW' && isAdmin" class="mt-6 flex gap-2">
            <button
              @click="approve"
              class="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
            >
              Approve
            </button>
            <button
              @click="reject"
              class="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
            >
              Reject
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { marked } from 'marked';

definePageMeta({ middleware: 'auth' });

const route = useRoute();
const router = useRouter();
const { isAdmin } = useAuth();
const { getScan, approveScan } = useApi();

const scanId = route.params.id as string;
const scan = ref<any>(null);
const loading = ref(true);
const videoUrl = ref('');

const config = useRuntimeConfig();

const renderMarkdown = (text: string) => {
  return marked(text);
};

const loadScan = async () => {
  loading.value = true;
  try {
    const result = await getScan(scanId);
    scan.value = result.scan;
    
    // Get presigned URL for video
    if (scan.value.objectKey) {
      const response = await fetch(`${config.public.apiEndpoint}/video-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objectKey: scan.value.objectKey })
      });
      const data = await response.json();
      videoUrl.value = data.url;
    }
  } catch (error) {
    console.error('Failed to load scan:', error);
  } finally {
    loading.value = false;
  }
};

const approve = async () => {
  try {
    await approveScan(scanId, true, 'Approved by admin');
    await loadScan();
    alert('Scan approved successfully');
  } catch (error) {
    console.error('Failed to approve:', error);
    alert('Failed to approve scan');
  }
};

const reject = async () => {
  const comments = prompt('Rejection reason (optional):');
  try {
    await approveScan(scanId, false, comments || 'Rejected by admin');
    await loadScan();
    alert('Scan rejected successfully');
  } catch (error) {
    console.error('Failed to reject:', error);
    alert('Failed to reject scan');
  }
};

const goBack = () => {
  router.back();
};

onMounted(() => {
  loadScan();
});
</script>
