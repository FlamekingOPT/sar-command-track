import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'SAR Searcher',
        short_name: 'SAR',
        start_url: '/',
        display: 'standalone',
        theme_color: '#1e293b',
        background_color: '#ffffff',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        navigateFallback: '/index.html',
        // The single JS bundle (mapbox-gl + firebase + turf) is ~3 MiB; it must
        // still precache or the app shell won't open offline.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // Serve cached Mapbox responses (style, tiles, glyphs, sprites) when offline.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\.mapbox\.com\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'mapbox',
              expiration: { maxEntries: 4000, maxAgeSeconds: 60 * 60 * 24 * 14 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  server: { port: 5174 },
  test: { environment: 'node' },
});
