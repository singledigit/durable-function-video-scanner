<template>
  <div class="relative max-w-2xl mx-auto">
    <!-- Poster with Play Button -->
    <div
      v-if="!isPlaying"
      @click="play"
      class="relative cursor-pointer group"
    >
      <video
        ref="videoElement"
        :src="videoUrl"
        class="w-full max-h-[600px] object-contain rounded-lg bg-black"
        preload="metadata"
      />
      <div class="absolute inset-0 flex items-center justify-center bg-black bg-opacity-30 group-hover:bg-opacity-40 transition rounded-lg">
        <div class="w-16 h-16 bg-white rounded-full flex items-center justify-center group-hover:scale-110 transition">
          <svg class="w-8 h-8 text-gray-800 ml-1" fill="currentColor" viewBox="0 0 20 20">
            <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
          </svg>
        </div>
      </div>
    </div>

    <!-- Playing Video -->
    <div v-else class="relative">
      <video
        ref="videoElement"
        :src="videoUrl"
        controls
        autoplay
        class="w-full max-h-[600px] object-contain rounded-lg bg-black"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  videoUrl: string;
}>();

const videoElement = ref<HTMLVideoElement | null>(null);
const isPlaying = ref(false);

const play = () => {
  isPlaying.value = true;
  nextTick(() => {
    videoElement.value?.play();
  });
};
</script>
