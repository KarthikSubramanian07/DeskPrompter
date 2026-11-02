import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import preact from '@preact/preset-vite'
import { VitePWA } from 'vite-plugin-pwa'
import { resolve } from 'node:path'

const root = import.meta.dirname

/** Clean routes in dev and preview, matching Cloudflare Pages: /studio → studio/index.html. */
const cleanRoutes = (): Plugin => {
  const rewrite = (req: { url?: string }, _res: unknown, next: () => void) => {
    const m = req.url?.match(/^\/(studio|remote)\/?(\?.*)?$/)
    if (m) req.url = `/${m[1]}/index.html${m[2] ?? ''}`
    next()
  }
  return {
    name: 'clean-routes',
    configureServer: (s) => void s.middlewares.use(rewrite),
    configurePreviewServer: (s) => void s.middlewares.use(rewrite),
  }
}

export default defineConfig({
  plugins: [
    cleanRoutes(),
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'robots.txt'],
      manifest: {
        name: 'DeskPrompter',
        short_name: 'DeskPrompter',
        description: 'A private, offline teleprompter that listens. Voice-follow scrolling runs on your device.',
        theme_color: '#12110F',
        background_color: '#12110F',
        display: 'standalone',
        start_url: '/studio',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        maximumFileSizeToCacheInBytes: 6_000_000,
        navigateFallbackDenylist: [/^\/api/],
      },
    }),
  ],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        studio: resolve(root, 'studio/index.html'),
        remote: resolve(root, 'remote/index.html'),
      },
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
