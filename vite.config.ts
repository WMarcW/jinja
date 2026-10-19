import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // relativ, damit die App unter https://<user>.github.io/<repo>/ läuft
  base: "./",
  build: { chunkSizeWarningLimit: 1500 },
  // MapLibre 6 lädt seinen Worker per new URL(..., import.meta.url) – nicht vorbündeln
  optimizeDeps: { exclude: ["maplibre-gl"] },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/*.png"],
      manifest: {
        name: "Jinja – Schreinkarte Japan",
        short_name: "Jinja",
        description: "Karte aller Shinto-Schreine Japans mit Besuchen, Goshuin und Fotos",
        lang: "de",
        start_url: ".",
        scope: ".",
        display: "standalone",
        background_color: "#faf7f2",
        theme_color: "#b7282e",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,mjs,css,html,png,svg}"],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          {
            // Schreindaten: sofort aus Cache, im Hintergrund aktualisieren
            urlPattern: /\/data\/.*\.json$/,
            handler: "StaleWhileRevalidate",
            options: { cacheName: "shrine-data" },
          },
          {
            // Kartenkacheln, Schriften, Sprites von OpenFreeMap
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\//,
            handler: "CacheFirst",
            options: {
              cacheName: "map-tiles",
              expiration: { maxEntries: 5000, maxAgeSeconds: 60 * 60 * 24 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
