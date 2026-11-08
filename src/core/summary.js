// Aggregations used by the day view and the trend view.

import { all, get, dateEq, dateBetween } from "../db.js";
import { bmr, energyBalance, round, weightTrend, daysBetween } from "./trend.js";

export const SLOTS = ["breakfast", "lunch", "dinner", "snack"];

export function dayMeals(db, date) {
  return all(db, `SELECT * FROM meals WHERE ${dateEq("date")} ORDER BY id`, date).map(decodeMeal);
}

function decodeMeal(row) {
  return {
    id: row.id,
    date: row.date,
    slot: row.slot,
    foodId: row.food_id,
    foodName: row.food_name,
    grams: row.grams,
    components: JSON.parse(row.components),
    kcal: row.kcal,
    carb: row.carb,
    protein: row.protein,
    fat: row.fat,
    alcohol: row.alcohol,
    note: row.note,
    createdAt: row.created_at,
  };
}

export function emptyTotals() {
  return { kcal: 0, carb: 0, protein: 0, fat: 0, alcohol: 0 };
}

export function addTotals(acc, n) {
  acc.kcal += n.kcal || 0;
  acc.carb += n.carb || 0;
  acc.protein += n.protein || 0;
  acc.fat += n.fat || 0;
  acc.alcohol += n.alcohol || 0;
  return acc;
}

export function finalizeTotals(t) {
  return {
    kcal: round(t.kcal, 0),
    carb: round(t.carb, 1),
    protein: round(t.protein, 1),
    fat: round(t.fat, 1),
    alcohol: round(t.alcohol, 1),
  };
}

export function daySummary(db, date) {
  const meals = dayMeals(db, date);
  const bySlot = {};
  const totals = emptyTotals();
  for (const slot of SLOTS) bySlot[slot] = { items: [], totals: finalizeTotals(emptyTotals()) };
  for (const m of meals) {
    bySlot[m.slot].items.push(m);
    addTotals(bySlot[m.slot].totals, m);
    addTotals(totals, m);
  }
  for (const slot of SLOTS) bySlot[slot].totals = finalizeTotals(bySlot[slot].totals);
  const activities = all(db, `SELECT * FROM activities WHERE ${dateEq("date")} ORDER BY id`, date).map((a) => ({
    id: a.id,
    date: a.date,
    method: a.method,
    label: a.label,
    minutes: a.minutes,
    kcal: a.kcal,
  }));
  const weight = get(db, `SELECT * FROM weights WHERE ${dateEq("date")}`, date);
  const attachments = all(db, `SELECT id, kind, file_name, mime, note FROM attachments WHERE ${dateEq("date")} ORDER BY id`, date);
  return {
    date,
    meals,
    bySlot,
    totals: finalizeTotals(totals),
    loggedMeals: meals.length,
    activities,
    activityKcal: activities.reduce((s, a) => s + a.kcal, 0),
    weight: weight ? { kg: weight.kg, note: weight.note } : null,
    attachments,
  };
}

export function profileWithAge(db, today) {
  const p = get(db, "SELECT * FROM profile WHERE id = 1");
  if (!p) return null;
  const age = p.birth_year ? Number(today.slice(0, 4)) - p.birth_year : null;
  return {
    name: p.name,
    sex: p.sex,
    birthYear: p.birth_year,
    age,
    heightCm: p.height_cm,
    restHr: p.rest_hr,
  };
}

/**
 * The trend view: smoothed weight curve plus a comparison of what the scale did
 * against what the energy balance predicts over the same window. This is the
 * only place where "is it working?" is answered — never from a single day.
 */
export function trendReport(db, { endDate, windowDays = 14, today }) {
  const windowDaysClamped = Math.min(Math.max(windowDays, 7), 42);
  const fromDate = isoAdd(endDate, -(windowDaysClamped - 1));
  const weights = all(db, "SELECT date, kg AS weight FROM weights ORDER BY date");
  const trend = weightTrend(weights, endDate, { windowDays: windowDaysClamped });

  const profile = profileWithAge(db, today);
  const inWindow = weights.filter((w) => String(w.date) >= fromDate && String(w.date) <= endDate);
  const totalsRow = get(
    db,
    `SELECT COUNT(DISTINCT date) AS days, COALESCE(SUM(kcal),0) AS kcal FROM meals WHERE ${dateBetween("date")}`,
    fromDate,
    endDate,
  );
  const actRow = get(
    db,
    `SELECT COUNT(DISTINCT date) AS days, COALESCE(SUM(kcal),0) AS kcal FROM activities WHERE ${dateBetween("date")}`,
    fromDate,
    endDate,
  );

  // BMR follows the measured weight; use the period-average weight, falling
  // back to the last known weight before the window.
  let refWeight = null;
  if (inWindow.length > 0) {
    refWeight = inWindow.reduce((s, w) => s + w.weight, 0) / inWindow.length;
  } else {
    const last = get(db, `SELECT kg FROM weights WHERE hex(date) <= hex(?) ORDER BY hex(date) DESC LIMIT 1`, endDate);
    refWeight = last ? last.kg : null;
  }
  const avgBmr =
    profile && profile.heightCm && profile.sex && refWeight
      ? Math.round(bmr({ sex: profile.sex, weightKg: refWeight, heightCm: profile.heightCm, age: profile.age ?? 30 }))
      : null;
  const daysWithActivity = Math.max(actRow.days, 1);
  const energy = energyBalance({
    loggedKcal: totalsRow.kcal,
    daysLogged: totalsRow.days,
    avgBmr,
    activityKcalPerDay: actRow.kcal / daysWithActivity,
  });

  const comparison = compareTrendWithEnergy(trend, energy);

  return {
    endDate,
    windowDays: windowDaysClamped,
    fromDate,
    trend,
    profile: profile
      ? { sex: profile.sex, heightCm: profile.heightCm, age: profile.age, referenceWeightKg: round(refWeight ?? 0, 1) }
      : null,
    energy,
    comparison,
    coverage: { mealDays: totalsRow.days, activityDays: actRow.days, weightReadings: inWindow.length },
  };
}

export function compareTrendWithEnergy(trend, energy) {
  if (trend.status !== "ok") {
    return { status: "insufficient", message: trend.message };
  }
  if (energy.status !== "ok") {
    return { status: "insufficient", message: energy.message };
  }
  const observed = trend.weeklyKg;
  const predicted = energy.predictedWeeklyKg;
  const gap = observed - predicted;
  // Uncertainty from the regression, plus a floor for food-compilation error.
  const band = trend.weeklyKgRange ? (trend.weeklyKgRange[1] - trend.weeklyKgRange[0]) / 2 : 0.3;
  const tolerance = Math.max(band, 0.3);
  const consistent = Math.abs(gap) <= tolerance;
  return {
    status: "ok",
    observedWeeklyKg: round(observed, 3),
    predictedWeeklyKg: round(predicted, 3),
    gapWeeklyKg: round(gap, 3),
    tolerance: round(tolerance, 2),
    consistent,
    message: consistent
      ? "体重趋势和记录的热量基本一致。单周数据会受食糜和水分影响，继续积累 1-2 周再看"
      : gap < 0
        ? "体重掉得比记录的热量应预测的更慢。常见原因：漏记饮食、吃到了没称重的食物、有氧少做、记录期间吸水肿（盐分/碳水增加/开始吃肌酸）。先补全记录，不要急着砍热量"
        : "体重掉得比预测的更快。可能是水分波动；如果连续两周如此，可以适当多吃一点避免肌肉流失",
  };
}

export function isoAdd(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export { daysBetween };
