import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { localMounts } from './scripts/vite-mounts';

export default defineConfig({
  // localMounts: mounts.json に書いたリポジトリ外のフォルダーを開発サーバへ生やす。
  // URDF のように外部メッシュを相対参照する形式を ?model= で開くために要る。
  plugins: [svelte(), localMounts()],
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
