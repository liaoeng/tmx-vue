<template>
  <div>
    <svg-icon icon-class="question" @click="goto" />
  </div>
</template>

<script setup lang="ts">
const url = ref(import.meta.env.VITE_APP_DOCS_URL || '');

function goto() {
  if (url.value) window.open(url.value, '_blank', 'noopener,noreferrer');
}
</script>
