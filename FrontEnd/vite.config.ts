/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // 실행 디렉터리와 무관하게 저장소 루트의 환경파일을 사용한다.
  envDir: fileURLToPath(new URL("..", import.meta.url)),
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
