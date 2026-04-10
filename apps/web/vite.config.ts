import path from 'node:path'
import { reactRouter } from '@react-router/dev/vite'
import tailwindcss from '@tailwindcss/vite'
import { reactRouterHonoServer } from 'react-router-hono-server/dev'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

const monorepoRoot = path.resolve(import.meta.dirname, '../..')

export default defineConfig({
  build: {
    target: 'esnext',
  },
  server: {
    host: true,
    port: Number(process.env.WEB_PORT ?? 3000),
    hmr: process.env.BEHIND_PROXY === 'true' ? { clientPort: 443 } : undefined,
    allowedHosts: true,
    fs: {
      allow: [monorepoRoot],
    },
  },
  plugins: [
    reactRouterHonoServer(),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],
})
