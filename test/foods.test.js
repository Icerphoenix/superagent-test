import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import { loadFoodDatabase, entryNutrients, searchFoods, macroKcal } from "../src/core/foods.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const db = loadFoodDatabase(join(ROOT, "data", "foods.json"));

test("food database loads from the workbook and has unique ids", () => {
  assert.ok(db.foods.length > 100);
  assert.equal(db.byId.size, db.foods.length);
});

test("rice: 150g of cooked rice is 45g carbs and ~188 kcal", () => {
  const rice = db.byId.get("rice");
  const n = entryNutrients(rice, { self: 100 }, 150);
  assert.equal(n.carb, 45);
  assert.equal(n.protein, 3.8);
  assert.equal(n.kcal, 199); // 45*4 + 3.8*4 + 0.5*9 = 199.05, rounded to 199
});

test("egg: 50g egg ≈ 6g protein and 5g fat, matching the workbook's fixed data", () => {
  const n = entryNutrients(db.byId.get("egg"), { self: 100 }, 50);
  assert.equal(n.protein, 6);
  assert.equal(n.fat, 5);
  assert.equal(n.kcal, 72); // 6*4 + 5*9, the workbook calls this 6g protein + 5g fat
});

test("milk: a 250ml box ≈ 10g protein, 9g fat, 12g carbs", () => {
  const n = entryNutrients(db.byId.get("milk"), { self: 100 }, 250);
  assert.equal(n.protein, 10);
  assert.equal(n.fat, 10);
  assert.equal(n.carb, 12.5);
});

test("mixed entries split total weight by component weights", () => {
  const oat = db.byId.get("oat_flake");
  // 40g oats + 250g milk, weighed as one bowl of 290g
  const n = entryNutrients(oat, { self: 100 }, 290);
  const alone = entryNutrients(oat, { self: 100 }, 290);
  assert.deepEqual(n, alone);
});

test("alcohol entries follow the workbook's 问答13 numbers", () => {
  // the person weighs what they consume: 600g beer ≈ 222 kcal, 50g 白酒 ≈ 175 kcal
  const b = entryNutrients(db.byId.get("beer"), { self: 50, alcohol: 50 }, 600);
  const j = entryNutrients(db.byId.get("baijiu"), { self: 50, alcohol: 50 }, 50);
  assert.ok(b.kcal > 40 && b.kcal < 250, `beer 600g ${JSON.stringify(b)}`);
  assert.ok(j.kcal > 0 && j.kcal < 220, `baijiu 50g ${JSON.stringify(j)}`);
});

test("macroKcal adds the four energy sources", () => {
  assert.equal(macroKcal({ carb: 10, protein: 10, fat: 10, alcohol: 10 }), 40 + 40 + 90 + 70);
});

test("search finds foods by common Chinese names", () => {
  assert.equal(searchFoods(db, "米饭")[0].id, "rice");
  assert.equal(searchFoods(db, "白米饭")[0].id, "rice");
  assert.ok(searchFoods(db, "鸡胸肉").slice(0, 2).map((f) => f.id).includes("meat_cooked"));
  assert.equal(searchFoods(db, "鸡蛋")[0].id, "egg");
  assert.ok(searchFoods(db, "banana").length > 0, "english alias should work");
});
