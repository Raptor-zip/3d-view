import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  server: {
    host: '127.0.0.1',
    port: 8000,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 8000,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    // Three.jsは初期描画に必要な既知のベンダーチャンク。分離後の容量に合わせる。
    chunkSizeWarningLimit: 550,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/three/')) return 'three';
          if (id.includes('/node_modules/svelte/')) return 'svelte';
          return undefined;
        },
      },
    },
  },
});
