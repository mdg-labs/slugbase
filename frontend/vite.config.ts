import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  build: {
    sourcemap: 'hidden',
    rollupOptions: {
      output: {
        manualChunks: {
          // Vendor chunks
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'i18n-vendor': ['i18next', 'react-i18next', 'i18next-browser-languagedetector'],
          'ui-vendor': ['lucide-react'],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    proxy: {
      '/api': {
        target: process.env.E2E_BACKEND_URL || 'http://localhost:5000',
        changeOrigin: true
      },
      // Proxy /go slug forwarding to backend
      '/go': {
        target: process.env.E2E_BACKEND_URL || 'http://localhost:5000',
        changeOrigin: true
      }
    }
  }
})
