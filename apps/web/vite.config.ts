import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "localhost",
    port: 5173,
    proxy: {
      "/health": "http://127.0.0.1:8765",
      "/api/v1": "http://127.0.0.1:8765",
      "/socket.io": {
        target: "http://127.0.0.1:8765",
        ws: true,
      },
    },
  },
  preview: {
    host: "localhost",
    port: 5173,
  },
  build: {
    outDir: "dist",
  },
});
