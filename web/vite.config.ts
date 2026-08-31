import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { outData } from './plugins/outData'

export default defineConfig({
  plugins: [react(), outData({ outDir: '../out' })],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5175,
    strictPort: true,
  },
  build: {
    sourcemap: true,
  },
  test: {
    // The data layer is pure; nothing under test touches the DOM yet.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'plugins/**/*.test.ts'],
    // The default 'threads'/'forks' pools fail to provide the vitest worker
    // state in this environment (every suite dies at its first describe with
    // "Cannot read properties of undefined (reading 'config')"); vmThreads
    // sets the state up inside the VM context and is the only pool that
    // runs.  Revisit if a vitest upgrade fixes the worker bootstrap.
    pool: 'vmThreads',
  },
})
