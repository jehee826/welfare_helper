import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(resolve(root, "dist"), { recursive: true });
await build({ absWorkingDir: root, entryPoints: ["src/app.jsx"], bundle: true,
  outfile: "dist/app.js", platform: "browser", format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' }, legalComments: "inline" });
for (const file of ["index.html", "overlay.html", "overlay.css"]) {
  await copyFile(resolve(root, "src", file), resolve(root, "dist", file));
}
console.log("Desktop 로컬 UI 빌드 완료");
