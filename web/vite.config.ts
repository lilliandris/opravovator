import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['logo.ico', 'logo.png', 'apple-touch-icon.png', 'fonts/*.ttf'],
      manifest: {
        name: 'opravOVÁTOR',
        short_name: 'opravOVÁTOR',
        description: 'Opravovanie PDF riešení korešpondenčných seminárov',
        lang: 'sk',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#232a36',
        theme_color: '#1b212b',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,ico,ttf,woff2}'],
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          {
            // výsledné PDF lokálnej úlohy – stránka ho sem vloží, aby malo v prehliadači správny názov súboru
            urlPattern: ({ url }) => url.pathname.startsWith('/local-pdf/'),
            handler: 'CacheOnly',
            options: { cacheName: 'local-pdfs' },
          },
          {
            // pôvodné PDF riešení sa nemenia → z cache (funguje offline)
            urlPattern: ({ url, request }) => request.method === 'GET' && /^\/api\/solutions\/\d+\/pdf$/.test(url.pathname),
            handler: 'CacheFirst',
            options: { cacheName: 'pdfs', expiration: { maxEntries: 5000 }, cacheableResponse: { statuses: [200] } },
          },
          {
            urlPattern: ({ url, request }) => request.method === 'GET' && /^\/api\/(assets\/\d+|solutions\/\d+\/thumb)$/.test(url.pathname),
            handler: 'CacheFirst',
            options: { cacheName: 'images', expiration: { maxEntries: 10000 }, cacheableResponse: { statuses: [200] } },
          },
          {
            // dáta: najprv sieť, pri výpadku posledná známa verzia
            urlPattern: ({ url, request }) => request.method === 'GET'
              && /^\/api\/(me|assets|auth\/config|tasks|tasks\/\d+|solutions\/\d+)$/.test(url.pathname),
            handler: 'NetworkFirst',
            options: { cacheName: 'api', networkTimeoutSeconds: 6, cacheableResponse: { statuses: [200] } },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: [
      { find: /^@opravovator\/shared\/render$/, replacement: new URL('../shared/src/render.ts', import.meta.url).pathname },
      { find: /^@opravovator\/shared$/, replacement: new URL('../shared/src/index.ts', import.meta.url).pathname },
    ],
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
