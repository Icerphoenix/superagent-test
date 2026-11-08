// Food database: data/foods.json is extracted from 好人松松's workbook
// (sheet 「19日常食物营养率」 and 「17减脂-问答汇总」). Every row stores the
// nutrient rate per 100g (or per 100ml / per weight for alcohol), never an
// "estimated portion": weights always come from the person's kitchen scale.

import { readFileSync } from "node:fs";
import { HttpError } from "./dates.js";

export const KCAL_PER_GRAM = { carb: 4, protein: 4, fat: 9, alcohol: 7 };

function sum4(a, b, c, d, ka, kb, kc, kd) {
  return a * ka + b * kb + c * kc + d * kd;
}

export function loadFoodDatabase(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const byId = new Map();
  for (const food of raw.foods) {
    if (byId.has(food.id)) throw new Error(`duplicate food id ${food.id}`);
    byId.set(food.id, food);
  }
  return { meta: raw, foods: raw.foods, byId };
}

/**
 * kcal for a set of nutrient amounts. Kept as a wide, pure helper so callers can
 * feed it plain objects or database rows alike.
 */
export function macroKcal(m) {
  const has = (v) => typeof v === "number";
  const amounts = [has(m.carb) ? m.carb : 0, has(m.protein) ? m.protein : 0, has(m.fat) ? m.fat : 0, has(m.alcohol) ? m.alcohol : 0];
  const total = sum4(amounts[0], amounts[1], amounts[2], amounts[3], KCAL_PER_GRAM.carb, KCAL_PER_GRAM.protein, KCAL_PER_GRAM.fat, KCAL_PER_GRAM.alcohol);
  return Number(total) || 0;
}

// Always emit every nutrient key, from the rate declared in `per100g`.
const NUTRIENT_KEYS = ["kcal", "carb", "protein", "fat"];

/** Nutrients of `grams` grams of one component of a food (empty for 0g). */
export function componentNutrients(component, grams) {
  const per = component.per100g || {};
  const f = grams / 100;
  const out = { kcal: 0, carb: 0, protein: 0, fat: 0 };
  for (const key of NUTRIENT_KEYS) out[key] = (per[key] || 0) * f;
  return out;
}

/**
 * Nutrients for a logged entry. A food can be composed of several components
 * (e.g. a bowl of oatmeal = oatmeal + milk); the user's weight is the total
 * weight of the entry, split by the component weights of the recipe.
 */
export function entryNutrients(food, componentWeights, totalGrams) {
  const sums = { kcal: 0, carb: 0, protein: 0, fat: 0, alcohol: 0 };
  let totalRecipe = 0;
  const parts = [];
  for (const [key, grams] of Object.entries(componentWeights || {})) {
    const comp = food.components[key];
    if (!comp) throw new HttpError(400, `食物 ${food.name} 没有组成项 ${key}`);
    totalRecipe += grams;
    parts.push([comp, grams]);
  }
  if (parts.length === 0) throw new HttpError(500, `食物 ${food.name} 没有组成项`);
  if (totalRecipe <= 0) throw new HttpError(400, "组成重量必须大于 0");
  for (const [comp, grams] of parts) {
    const n = componentNutrients(comp, (grams / totalRecipe) * totalGrams);
    const amounts = [n.kcal, n.carb, n.protein, n.fat, n.alcohol || 0];
    sums.kcal += amounts[0];
    sums.carb += amounts[1];
    sums.protein += amounts[2];
    sums.fat += amounts[3];
    sums.alcohol += amounts[4];
  }
  return {
    kcal: round(sums.kcal, 1),
    carb: round(sums.carb, 1),
    protein: round(sums.protein, 1),
    fat: round(sums.fat, 1),
    ...(sums.alcohol > 0 ? { alcohol: round(sums.alcohol, 1) } : {}),
  };
}

export function round(x, digits = 1) {
  const p = 10 ** digits;
  return Math.round((x + Number.EPSILON) * p) / p;
}

/** Default single-component weight percentages for a food. */
export function defaultComponents(food) {
  const keys = Object.keys(food.components);
  const out = {};
  for (const k of keys) out[k] = 100 / keys.length;
  return out;
}

export function searchFoods(db, query, limit = 20) {
  const q = (query || "").trim().toLowerCase();
  const scored = [];
  for (const food of db.foods) {
    const hay = [food.name, ...(food.aliases || []), ...(food.aliases || []).map((a) => a.replace(/（.*?）|\(.*?\)/g, ""))];
    let score = 0;
    for (const h of hay) {
      const s = h.toLowerCase();
      if (s === q) score = Math.max(score, 100);
      else if (s.startsWith(q)) score = Math.max(score, 60);
      else if (s.includes(q)) score = Math.max(score, 30);
      else if (food.id === q) score = Math.max(score, 90);
    }
    if (q === "") score = 1;
    if (score > 0) scored.push({ food, score });
  }
  scored.sort((a, b) => b.score - a.score || a.food.name.localeCompare(b.food.name, "zh"));
  return scored.slice(0, limit).map((s) => s.food);
}
