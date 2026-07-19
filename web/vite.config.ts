import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxy target for the API server (override when 8787 is taken,
// e.g. CC_API_PROXY=http://localhost:8788 npm run dev -w web).
const api = process.env.CC_API_PROXY ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: api, changeOrigin: true },
      "/twilio": { target: api, changeOrigin: true },
      "/media-stream": { target: api.replace(/^http/, "ws"), ws: true },
    },
  },
  build: {
    outDir: "dist",
  },
});
