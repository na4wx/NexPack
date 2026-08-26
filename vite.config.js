import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src',
  base: './',
  plugins: [react()],
  server: { port: 5180, strictPort: true },
  build: {
    outDir: '../dist',
    emptyOutDir: true
  }
});
