import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: the CRM API runs on :8100 (backend), proxied under /api.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: 'http://localhost:8100', changeOrigin: true },
    },
  },
})
