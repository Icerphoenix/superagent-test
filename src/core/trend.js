// Weight trend and energy-balance math.
//
// The workbook says it plainly (「8减脂-无力训者」B9, 「17减脂-问答汇总」问答20):
// a few days of scale readings are dominated by gut content and water, so a
// meaningful comparison needs at least 1-2 weeks. We therefore never show a
// "current weight" as if it were body fat: we show a smoothed trend plus a
// slope with uncertainty, and only quote a trend when there is enough data.

export const ENERGY_PER_KG_FAT = 7700;

/**
 * Time-smoothed weight curve (exponential, one step per possible day).
 * readings: [{date, weight}] (one per date, ascending). `tau` controls how many
 * days of past readings effectively contribute.
 */
export function ewmaSeries(readings, tau = 14) {
  if (readings.length === 0) return [];
  const byDate = new Map(readings.map((r) => [r.date, r.weight]));
  const alpha = 1 - Math.exp(-1 / tau);
  const first = readings[0].date;
  const last = readings[readings.length - 1].date;
  const out = [];
  let level = readings[0].weight;
  let haveLevel = true;
  let cursor = new Date(`${first}T00:00:00Z`);
  const end = new Date(`${last}T00:00:00Z`);
  while (cursor <= end) {
    const day = cursor.toISOString().slice(0, 10);
    const w = byDate.get(day);
    if (w !== undefined) {
      level = haveLevel ? level + alpha * (w - level) : w;
      haveLevel = true;
    }
    out.push({ date: day, trend: round(level, 3), measured: w !== undefined ? w : null });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** Ordinary least squares slope of y on day index. */
function ols(ys) {
  const n = ys.length;
  if (n < 2) return { slope: 0, se: Infinity, n };
  const xm = (n - 1) / 2;
  const ym = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += (i - xm) ** 2;
    sxy += (i - xm) * (ys[i] - ym);
  }
  const slope = sxy / sxx;
  let sse = 0;
  for (let i = 0; i < n; i += 1) sse += (ys[i] - (ym + slope * (i - xm))) ** 2;
  const se = n > 2 ? Math.sqrt(sse / (n - 2) / sxx) : Infinity;
  return { slope, se, n };
}

/**
 * Trend report over the trailing `windowDays` (default 14) up to `endDate`
 * inclusive. Comparisons use the smoothed curve, and we quote a range rather
 * than a single number.
 */
export function weightTrend(weightsAsc, endDate, { windowDays = 14, minSpanDays = 10 } = {}) {
  const inWindow = [];
  const endTs = new Date(`${endDate}T00:00:00Z`).getTime();
  for (const w of weightsAsc) {
    const ts = new Date(`${w.date}T00:00:00Z`).getTime();
    const age = (endTs - ts) / 86400000;
    if (age >= 0 && age < windowDays) inWindow.push(w);
  }
  if (inWindow.length === 0) {
    return {
      status: "insufficient",
      window: { from: null, to: endDate, days: 0 },
      readings: 0,
      message: "还没有这段时间的体重记录",
    };
  }
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  const spanDays = daysBetween(last.date, first.date);
  const curve = ewmaSeries(inWindow, 14);
  const trendAtEnd = curve[curve.length - 1].trend;
  const trendAtStart = curve[0].trend;
  const slopeFit = ols(curve.map((c) => c.trend));
  // kg/week, with a 1.96·SE band (≈95%) around it
  const perWeek = slopeFit.slope * 7;
  const band = Number.isFinite(slopeFit.se) ? slopeFit.se * 7 * 1.96 : null;
  const base = {
    window: { from: first.date, to: last.date, days: spanDays + 1 },
    readings: inWindow.length,
    measuredChange: round(last.weight - first.weight, 2),
    trendStart: round(trendAtStart, 2),
    trendEnd: round(trendAtEnd, 2),
    trendChange: round(trendAtEnd - trendAtStart, 2),
    weeklyKg: round(perWeek, 3),
    weeklyKgRange: band === null ? null : [round(perWeek - band, 3), round(perWeek + band, 3)],
    series: curve.map((c) => ({ date: c.date, trend: round(c.trend, 2), measured: c.measured })),
    tauDays: 14,
  };
  if (spanDays + 1 < minSpanDays || inWindow.length < 3) {
    return {
      ...base,
      status: "insufficient",
      message: `最近 ${spanDays + 1} 天的数据还不够（至少需要 ${minSpanDays} 天、3 次称重）。单次或两三天的体重变化主要反映食糜和水分，没有参考意义`,
    };
  }
  return { ...base, status: "ok" };
}

export function daysBetween(a, b) {
  return Math.round(
    (new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86400000,
  );
}

/** Mifflin-St Jeor, the formula the workbook uses. */
export function bmr({ sex, weightKg, heightCm, age }) {
  return 9.99 * weightKg + 6.25 * heightCm - 4.92 * age + (sex === "male" ? 5 : -161);
}

/** Intake vs predicted burn over the same period. */
export function energyBalance({ loggedKcal, daysLogged, avgBmr, activityKcalPerDay = 0 }) {
  if (avgBmr == null || daysLogged === 0) {
    return { status: "insufficient", message: "需要身高、体重、年龄，以及至少一天的饮食记录" };
  }
  // The workbook treats BMR as ~70% of maintenance on a no-exercise day; the
  // other 30% is food thermogenesis + daily activity.
  const maintenance = avgBmr / 0.7 + activityKcalPerDay;
  const avgIntake = loggedKcal / daysLogged;
  const avgDeficit = maintenance - avgIntake;
  return {
    status: "ok",
    avgIntakeKcal: round(avgIntake, 0),
    maintenanceKcal: round(maintenance, 0),
    activityKcalPerDay: round(activityKcalPerDay, 0),
    avgDeficitKcal: round(avgDeficit, 0),
    predictedWeeklyKg: round((-avgDeficit * 7) / ENERGY_PER_KG_FAT, 3),
  };
}

export function round(x, digits = 1) {
  const p = 10 ** digits;
  return Math.round((x + Number.EPSILON) * p) / p;
}
