import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { startVitest } from "vitest/node";

const root = fileURLToPath(new URL("..", import.meta.url));
const options = { root, configFile: false, envFile: false, plugins: [react()] };
if (process.argv[2] === "test") {
  process.env.VITE_API_BASE_URL = "";
  const runner = await startVitest("test", process.argv.slice(3), { run: true }, {
    ...options,
    test: { environment: "jsdom", globals: true, setupFiles: [fileURLToPath(new URL("../src/test/setup.ts", import.meta.url))] },
  });
  if (!runner) process.exitCode = 1;
  else {
    const files = runner.state.getFiles();
    if (!files.length || files.some(file => file.result?.state === "fail") || runner.state.getUnhandledErrors().length) process.exitCode = 1;
    await runner.close();
  }
} else if (process.argv[2] === "build") {
  await build(options);
} else {
  throw new Error("test 또는 build를 지정하세요.");
}
