import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { createApp } from "../src/server.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "cdt-"));
  const app = createApp({
    dbPath: ":memory:",
    foodsPath: join(ROOT, "data", "foods.json"),
    dataDir: dir,
  });
  const addr = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${addr.port}`;
  const call = async (path, { method = "GET", body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  return { app, base, call, close: () => new Promise((ok) => app.server.close(ok)) };
}

test("a day round-trips: add a meal, see totals and per-slot sums", async () => {
  const s = await boot();
  try {
    const added = await s.call("/api/meals", {
      method: "POST",
      body: { date: "2026-11-08", slot: "lunch", foodId: "rice", grams: 200 },
    });
    assert.equal(added.status, 200);
    assert.equal(added.data.nutrients.carb, 60);

    await s.call("/api/meals", {
      method: "POST",
      body: { date: "2026-11-08", slot: "breakfast", foodId: "egg", grams: 50, note: "水煮蛋" },
    });

    const day = await s.call("/api/days/2026-11-08");
    assert.equal(day.data.day.totals.carb, 60.8);
    assert.equal(day.data.day.totals.protein, 11);
    assert.equal(day.data.day.bySlot.lunch.items.length, 1);
    assert.equal(day.data.day.bySlot.dinner.items.length, 0);
    assert.equal(day.data.day.loggedMeals, 2);
  } finally {
    await s.close();
  }
});

test("bad input is rejected, not silently stored", async () => {
  const s = await boot();
  try {
    assert.equal((await s.call("/api/meals", { method: "POST", body: { date: "2026-13-01", foodId: "rice", grams: 100 } })).status, 400);
    assert.equal((await s.call("/api/meals", { method: "POST", body: { date: "2026-11-08", foodId: "nope", grams: 100 } })).status, 400);
    assert.equal((await s.call("/api/meals", { method: "POST", body: { date: "2026-11-08", foodId: "rice", grams: -5 } })).status, 400);
    assert.equal((await s.call("/api/weights/2026-11-08", { method: "PUT", body: { kg: 3 } })).status, 400);
    assert.equal((await s.call("/api/days/2026-02-30")).status, 400);
  } finally {
    await s.close();
  }
});

test("weight upsert and delete", async () => {
  const s = await boot();
  try {
    await s.call("/api/weights/2026-11-08", { method: "PUT", body: { kg: 76.4 } });
    await s.call("/api/weights/2026-11-08", { method: "PUT", body: { kg: 76.1 } });
    let list = await s.call("/api/weights");
    assert.deepEqual(list.data.weights.map((w) => w.kg), [76.1]);
    await s.call("/api/weights/2026-11-08", { method: "PUT", body: { kg: null } });
    list = await s.call("/api/weights");
    assert.equal(list.data.weights.length, 0);
  } finally {
    await s.close();
  }
});

test("activities need a weight for the day and land in the day view", async () => {
  const s = await boot();
  try {
    const noWeight = await s.call("/api/activities", {
      method: "POST",
      body: { date: "2026-11-08", method: "activity", group: "平地走", detail: "每走一小时", minutes: 60 },
    });
    assert.equal(noWeight.status, 400);

    await s.call("/api/weights/2026-11-07", { method: "PUT", body: { kg: 75 } });
    const ok = await s.call("/api/activities", {
      method: "POST",
      body: { date: "2026-11-08", method: "activity", group: "平地走", detail: "每走一小时", minutes: 60 },
    });
    assert.equal(ok.status, 200);
    // 3.8 kcal/kg/h × 75kg × 1h
    assert.equal(ok.data.kcal, 285);

    const hr = await s.call("/api/activities", {
      method: "POST",
      body: { date: "2026-11-08", method: "hr", restHr: 60, activeHr: 120, minutes: 30 },
    });
    assert.equal(hr.status, 200);
    assert.ok(hr.data.kcal > 200 && hr.data.kcal < 300, `hr kcal ${hr.data.kcal}`);

    const day = await s.call("/api/days/2026-11-08");
    assert.equal(day.data.day.activities.length, 2);
    assert.equal(day.data.day.activityKcal, ok.data.kcal + hr.data.kcal);
  } finally {
    await s.close();
  }
});

test("trend stays insufficient until two weeks of weights exist", async () => {
  const s = await boot();
  try {
    await s.call("/api/profile", {
      method: "PUT",
      body: { sex: "male", heightCm: 170, birthYear: 2000, restHr: 60 },
    });
    for (let i = 0; i < 5; i += 1) {
      const d = new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10);
      await s.call(`/api/weights/${d}`, { method: "PUT", body: { kg: 75 - i * 0.2 } });
      await s.call("/api/meals", { method: "POST", body: { date: d, slot: "lunch", foodId: "rice", grams: 200 } });
    }
    let report = (await s.call("/api/trend?endDate=2026-11-05")).data.report;
    assert.equal(report.trend.status, "insufficient");
    assert.equal(report.comparison.status, "insufficient");

    for (let i = 5; i < 15; i += 1) {
      const d = new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10);
      await s.call(`/api/weights/${d}`, { method: "PUT", body: { kg: 75 - i * 0.2 } });
      await s.call("/api/meals", { method: "POST", body: { date: d, slot: "lunch", foodId: "rice", grams: 200 } });
    }
    report = (await s.call("/api/trend?endDate=2026-11-15")).data.report;
    assert.equal(report.trend.status, "ok");
    assert.ok(report.trend.weeklyKg < 0);
    assert.equal(report.energy.status, "ok");
    assert.equal(report.comparison.status, "ok");
    assert.ok(Number.isFinite(report.comparison.gapWeeklyKg));
  } finally {
    await s.close();
  }
});

test("food search and the static page", async () => {
  const s = await boot();
  try {
    const res = await s.call("/api/foods?q=鸡胸肉");
    assert.ok(res.data.foods.length > 0);
    const page = await fetch(`${s.base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /热量赤字追踪/);
  } finally {
    await s.close();
  }
});
