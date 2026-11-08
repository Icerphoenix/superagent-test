#!/usr/bin/env node
// Start the local tracker. Data lives in one file: data/db.sqlite by default.

import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { exec } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

import { createApp } from "../src/server.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { values } = parseArgs({
  options: {
    port: { type: "string", default: process.env.PORT || "8765" },
    host: { type: "string", default: "127.0.0.1" },
    db: { type: "string", default: process.env.CDT_DB || join(ROOT, "data", "db.sqlite") },
    open: { type: "boolean", default: false },
  },
});

const dataDir = join(ROOT, "data");
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const app = createApp({
  dbPath: values.db,
  foodsPath: join(ROOT, "data", "foods.json"),
  dataDir,
});

const addr = await app.listen(Number(values.port), values.host);
const url = `http://${values.host}:${addr.port}/`;
console.log(`热量赤字追踪已启动： ${url}`);
console.log(`数据文件： ${resolve(values.db)}`);
console.log("按 Ctrl+C 停止。");

if (values.open) {
  const cmd =
    process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

const shutdown = () => {
  app.server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
