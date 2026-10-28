/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      // 로컬 접수의 동일 출처 검사에 맞춰 브라우저 Host·Origin을 유지한다.
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: false, xfwd: false },
      "/health": { target: "http://127.0.0.1:8000", changeOrigin: false, xfwd: false },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
  },
});
