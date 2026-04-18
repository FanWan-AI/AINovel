import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 4567,
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.INKOS_STUDIO_PORT ?? "4569"}`,
        changeOrigin: true,
        timeout: 1_800_000,
        proxyTimeout: 1_800_000,
        configure: (proxy) => {
          // Disable buffering for SSE streams so events are forwarded immediately
          proxy.on("proxyRes", (proxyRes, req) => {
            if (req.url?.includes("/assistant/chat") || req.url?.includes("/api/events")) {
              proxyRes.headers["cache-control"] = "no-cache";
              proxyRes.headers["x-accel-buffering"] = "no";
            }
          });
        },
      },
    },
  },
});
