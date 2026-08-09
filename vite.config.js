import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/',
  plugins: [
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['logo.png', 'favicon.ico'],
      strategies: 'generateSW',
      filename: 'sw.js',
      manifest: {
        name: 'EDT EPS Vauban - Emploi du Temps',
        short_name: 'EDT EPS',
        description: 'Emploi du temps EPS – Lycée Vauban. Gestion des tâches, du planning, des absences et des remplacements.',
        theme_color: '#002b5b',
        background_color: '#f2f8fc',
        display: 'standalone',
        orientation: 'portrait-primary',
        scope: '/',
        start_url: '/?utm_source=pwa',
        categories: ['education', 'productivity'],
        prefer_related_applications: false,
        screenshots: [
          { src: 'logo.png', sizes: '540x720', type: 'image/png', form_factor: 'narrow' },
          { src: 'logo.png', sizes: '1024x600', type: 'image/png', form_factor: 'wide' },
        ],
        icons: [
          { src: 'logo.png', sizes: '64x64', type: 'image/png' },
          { src: 'logo.png', sizes: '96x96', type: 'image/png' },
          { src: 'logo.png', sizes: '128x128', type: 'image/png' },
          { src: 'logo.png', sizes: '192x192', type: 'image/png' },
          { src: 'logo.png', sizes: '256x256', type: 'image/png' },
          { src: 'logo.png', sizes: '384x384', type: 'image/png' },
          { src: 'logo.png', sizes: '512x512', type: 'image/png' },
          { src: 'logo.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'logo.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'logo.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'logo.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          {
            name: 'EDT',
            short_name: 'EDT',
            description: 'Afficher l\'emploi du temps',
            url: '/?view=edt',
            icons: [{ src: 'logo.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: 'Tâches',
            short_name: 'Tâches',
            description: 'Voir vos tâches',
            url: '/?view=tasks',
            icons: [{ src: 'logo.png', sizes: '192x192', type: 'image/png' }],
          },
        ],
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff,woff2}'],
        globIgnores: ['**/node_modules/**/*', '.map'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'cdn-cache',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/firestore\.googleapis\.com\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'firestore-cache',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
        ],
      },
      devOptions: {
        enabled: true,
        suppressWarnings: true,
        navigateFallback: 'index.html',
      },
    }),
  ],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'node',
  },
});
