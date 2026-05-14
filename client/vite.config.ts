import path from "path";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "../shared/src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/socket.io": {
        target: "http://127.0.0.1:3000",
        ws: true,
      },
    },
  },
});
