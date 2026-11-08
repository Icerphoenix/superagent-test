// UI smoke test: renders public/ui-smoke.html (the real app shell + app.js with a
// stubbed API) in headless Chrome for every view, and checks that no view shows
// the app's own error banner and that the expected sections are present.
//
// Run with `npm run test:ui`. Requires Chrome; set CHROME=/path/to/chrome if it
// is not at the default location.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { createApp } from "../src/server.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME =
  process.env.CHROME ||
  (process.platform === "win32"
    ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
    : "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe");

const toWindowsPath = (p) =>
  process.platform === "linux" && p.startsWith("/mnt/")
    ? p.replace(/^\/mnt\/([a-z])\//, (_, d) => `${d.toUpperCase()}:\\`).replace(/\//g, "\\")
    : p;

function render(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=8000", "--dump-dom", toWindowsPath(url)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let dom = "";
    child.stdout.on("data", (d) => (dom += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`chrome exited ${code}`));
      else resolve(dom);
    });
  });
}

const views = [
  {
    hash: "#/day/2026-11-05",
    expect: ["热量", "碳水", "蛋白质", "脂肪", "记录饮食", "鸡蛋", "有氧", "仅作记录"],
  },
  {
    hash: "#/trend",
    expect: ["体重趋势", "kg / 周", "记录的平均摄入", "预计维持热量", "两者对得上吗"],
  },
  { hash: "#/history", expect: ["体重记录", "kg"] },
  { hash: "#/settings", expect: ["个人资料", "静息心率", "SQLite"] },
];

const app = createApp({ dbPath: ":memory:", foodsPath: join(ROOT, "data", "foods.json"), dataDir: mkdtempSync(join(tmpdir(), "cdt-ui-")) });
const addr = await app.listen(0, "127.0.0.1");
const base = `http://127.0.0.1:${addr.port}`;
let failures = 0;
try {
  for (const view of views) {
    const dom = await render(`${base}/ui-smoke.html${view.hash}`);
    const text = dom.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ");
    try {
      assert.ok(!text.includes("出错了"), `${view.hash}: app rendered an error banner`);
      assert.ok(!text.includes("加载中"), `${view.hash}: view never finished loading`);
      for (const needle of view.expect) assert.ok(text.includes(needle), `${view.hash}: missing "${needle}"`);
      console.log(`ok ${view.hash}`);
    } catch (err) {
      failures += 1;
      console.error(`not ok ${view.hash}: ${err.message}`);
    }
  }
} finally {
  await new Promise((ok) => app.server.close(ok));
}
if (failures > 0) {
  console.error(`${failures} view(s) failed`);
  process.exit(1);
}
console.log("ui smoke passed");
