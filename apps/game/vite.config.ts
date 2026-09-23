import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { fs: { allow: ['../..'] } },
  // three.js (the 3D view) is its own chunk, loaded when a shift starts.
  build: { chunkSizeWarningLimit: 700 },
});
