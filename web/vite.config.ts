import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { resolveHost, resolveOutDir, resolvePort } from './plugins/devServer'
import { outData } from './plugins/outData'

export default defineConfig({
  // tic-ac17: 'vcall serve --dev' points the plugin at the store it was given
  // through VCALL_OUT_DIR; unset keeps '../out', so `npm run dev` is unchanged.
  plugins: [react(), outData({ outDir: resolveOutDir(process.env.VCALL_OUT_DIR) })],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    // tic-ac17: 5175 + strictPort is what `npm run dev` and the F5 launch config
    // expect, so it stays the default.  'vcall serve --dev' replaces the port
    // through VCALL_PORT -- and strictPort stays *on* for it: the port either
    // binds or Vite fails loudly, because the CLI printed that port as the URL
    // and silently moving to another one would make the URL a lie.
    port: resolvePort(process.env.VCALL_PORT),
    strictPort: true,
    host: resolveHost(process.env.VCALL_HOST),
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
