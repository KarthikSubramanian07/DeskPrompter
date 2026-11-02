import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import preact from '@preact/preset-vite'
import { VitePWA } from 'vite-plugin-pwa'
import { resolve } from 'node:path'

const root = import.meta.dirname

/**
 * Cross-origin isolation, so Moonshine's threaded WebAssembly gets SharedArrayBuffer.
 * Mirrors public/_headers (Cloudflare Pages). require-corp is safe here: every
 * subresource is same-origin, and model downloads are CORS fetches.
 */
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

/** Clean routes in dev and preview, matching Cloudflare Pages: /studio → studio.html. */
const cleanRoutes = (): Plugin => {
  const rewrite = (req: { url?: string }, _res: unknown, next: () => void) => {
    const m = req.url?.match(/^\/(studio|remote)\/?(\?.*)?$/)
    if (m) req.url = `/${m[1]}.html${m[2] ?? ''}`
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
      includeAssets: ['icon-192.png', 'apple-touch-icon.png', 'robots.txt'],
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
        // Moonshine's 13 MB runtime is too big to precache; its worker caches it on first use.
        globIgnores: ['**/og.png', '**/moonshine-*.wasm'],
        // Each page is its own entry; precache's cleanURLs maps /studio → studio.html offline.
        navigateFallback: null,
      },
    }),
  ],
  // Moonshine's Emscripten glue uses top-level await and spawns nested module
  // workers, which the default 'iife' worker format cannot express.
  worker: { format: 'es' },
  server: { headers: isolation },
  preview: { headers: isolation },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        studio: resolve(root, 'studio.html'),
        remote: resolve(root, 'remote.html'),
      },
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
