import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { alphaTab } from '@coderline/alphatab-vite';

// Tauri sets TAURI_DEV_HOST when running `tauri android dev` so the device can reach the dev server.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // Relative base keeps asset URLs valid inside the Tauri webview (desktop + Android) and plain static hosting.
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    // Copies Bravura SMuFL fonts + soundfont-free worker/worklet entry points into the bundle
    // and rewrites alphaTab's worker URLs so they resolve in dev, build and Tauri.
    alphaTab(),
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: ['es2021', 'chrome100', 'safari15'],
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 4096,
  },
  worker: {
    format: 'es',
  },
});
