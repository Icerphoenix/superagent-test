import test from "node:test";
import assert from "node:assert/strict";

import { ewmaSeries, weightTrend } from "../src/core/trend.js";
import { compareTrendWithEnergy } from "../src/core/summary.js";

function series(days, fn) {
  const out = [];
  const d = new Date("2026-10-01T00:00:00Z");
  for (let i = 0; i < days; i += 1) {
    const day = new Date(d.getTime() + i * 86400000).toISOString().slice(0, 10);
    const w = fn(i);
    if (w !== null) out.push({ date: day, weight: w });
  }
  return out;
}

test("ewma follows a day-by-day curve, lags it, and keeps every date", () => {
  const readings = series(10, (i) => 80 - i * 0.1);
  const curve = ewmaSeries(readings);
  assert.equal(curve.length, 10);
  assert.equal(curve[0].trend, 80);
  // a 14-day smoothing time constant lags the daily line but stays close to it
  assert.ok(curve[9].trend < 80 && curve[9].trend > 79.0, `got ${curve[9].trend}`);
});

test("a few days of noisy readings are not enough for a trend", () => {
  const readings = series(4, (i) => 80 + (i % 2 ? 0.6 : -0.6));
  const t = weightTrend(readings, readings.at(-1).date);
  assert.equal(t.status, "insufficient");
  assert.match(t.message, /1-2|10 天/);
});

test("two weeks of steady loss gives a negative slope with a range", () => {
  const readings = series(14, (i) => 80 - 0.05 * i + (i % 3 === 0 ? 0.35 : 0));
  const t = weightTrend(readings, readings.at(-1).date);
  assert.equal(t.status, "ok");
  assert.ok(t.weeklyKg < 0, `weeklyKg ${t.weeklyKg}`);
  assert.ok(t.weeklyKg > -0.6, `weeklyKg ${t.weeklyKg}`);
  assert.ok(t.weeklyKgRange[0] < t.weeklyKg && t.weeklyKg < t.weeklyKgRange[1]);
  assert.equal(t.series.length, 14);
});

test("flat weight over two weeks reports ~0 kg/week", () => {
  const readings = series(14, (i) => 77 + (i % 2 ? 0.2 : -0.2));
  const t = weightTrend(readings, readings.at(-1).date);
  assert.equal(t.status, "ok");
  assert.ok(Math.abs(t.weeklyKg) < 0.1, `weeklyKg ${t.weeklyKg}`);
});

test("comparison flags a gap between the scale and the recorded deficit", () => {
  const trend = { status: "ok", weeklyKg: 0.02, weeklyKgRange: [-0.1, 0.14] };
  const energy = { status: "ok", predictedWeeklyKg: -0.5 };
  const c = compareTrendWithEnergy(trend, energy);
  assert.equal(c.status, "ok");
  assert.equal(c.consistent, false);
  assert.ok(c.gapWeeklyKg > 0.4);
  assert.match(c.message, /漏记|没称重|水分/);
});

test("comparison accepts a matching trend", () => {
  const trend = { status: "ok", weeklyKg: -0.45, weeklyKgRange: [-0.5, -0.4] };
  const energy = { status: "ok", predictedWeeklyKg: -0.5 };
  const c = compareTrendWithEnergy(trend, energy);
  assert.equal(c.consistent, true);
});
