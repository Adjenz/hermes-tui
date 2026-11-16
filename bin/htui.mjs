#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const entry = path.join(rootDir, "src", "index.tsx");
const localTsx = path.join(rootDir, "node_modules", ".bin", "tsx");
const tsxCmd = fs.existsSync(localTsx) ? localTsx : "tsx";

const child = spawn(tsxCmd, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
