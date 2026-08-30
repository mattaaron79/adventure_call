import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { outData } from './plugins/outData'

export default defineConfig({
  plugins: [react(), outData({ outDir: '../out' })],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    sourcemap: true,
  },
})
