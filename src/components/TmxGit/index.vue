<template>
  <div>
    <svg-icon icon-class="github" @click="goto" />
  </div>
</template>

<script setup lang="ts">
const url = ref(import.meta.env.VITE_APP_SOURCE_URL || '');

function goto() {
  if (url.value) window.open(url.value, '_blank', 'noopener,noreferrer');
}
</script>
