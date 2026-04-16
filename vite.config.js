import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Vite dev server (optional for local prototyping)
  // For production, run `npm run deploy` which builds + deploys to Cloudflare
  server: {
    port: 5173,
    proxy: {
      // Dev mode: proxy /api to a local wrangler dev instance if running
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    include: ["pdfjs-dist/build/pdf.mjs"],
  },
  worker: {
    format: "es",
  },
  build: {
    // Keep output in ./dist so wrangler.toml [assets] can find it
    outDir: "dist",
    // Chunk size warning is fine —龙爪手本身就是大应用
    chunkSizeWarningLimit: 2000,
  },
});
