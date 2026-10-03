import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const API = process.env.API_URL || 'http://localhost:8787'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // reachable from a phone on the same Wi-Fi
    proxy: { '/api': { target: API, changeOrigin: true } },
  },
  preview: {
    proxy: { '/api': { target: API, changeOrigin: true } },
  },
  build: {
    rollupOptions: {
      input: {
        landing: resolve(__dirname, 'index.html'),
        app: resolve(__dirname, 'app.html'),
      },
    },
  },
  worker: {
    // elah's export runs in a module worker; Vite's default IIFE format cannot use import.
    format: 'es',
  },
  optimizeDeps: {
    // esbuild's pre-bundle rewrites the worker's `new URL(...)` reference and breaks it.
    exclude: ['@elah/editor', '@elah/core', '@elah/react', '@elah/timeline', 'mediabunny'],
  },
})
