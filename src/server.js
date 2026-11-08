// Local-only HTTP server: JSON API + static UI. No accounts, no auth, no
// outbound requests — it binds to 127.0.0.1 and stores everything in one
// SQLite file next to it.

import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createReadStream, existsSync, statSync } from "node:fs";

const isDirectory = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
import { extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { openDatabase, all, get, run, dateEq, dateBetween } from "./db.js";
import { HttpError, isDate, requireDate, todayLocal } from "./core/dates.js";
import {
  loadFoodDatabase,
  entryNutrients,
  defaultComponents,
  searchFoods,
  round,
} from "./core/foods.js";
import { daySummary, trendReport, profileWithAge, isoAdd, SLOTS } from "./core/summary.js";
import { activityKcal, hrMethodKcal } from "./core/activity.js";
import activitiesData from "../data/activities.json" with { type: "json" };

const here = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(here, "..");

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function createApp({ dbPath, foodsPath, dataDir }) {
  const db = openDatabase(dbPath);
  const foods = loadFoodDatabase(foodsPath);
  const uploadDir = join(dataDir, "attachments");
  mkdir(uploadDir, { recursive: true }).catch(() => {});

  const routes = [];
  function route(method, pattern, handler) {
    const keys = [];
    const re = new RegExp(
      `^${pattern.replace(/:([a-zA-Z]+)/g, (_, k) => {
        keys.push(k);
        return "([^/]+)";
      })}$`,
    );
    routes.push({ method, re, keys, handler });
  }

  const now = () => new Date().toISOString();

  // ---------- profile ----------
  route("GET", "/api/profile", () => {
    const p = get(db, "SELECT * FROM profile WHERE id = 1");
    return {
      profile: p
        ? { name: p.name, sex: p.sex, birthYear: p.birth_year, heightCm: p.height_cm, restHr: p.rest_hr }
        : null,
    };
  });

  route("PUT", "/api/profile", (req) => {
    const b = req.body || {};
    const sex = b.sex === "female" ? "female" : b.sex === "male" ? "male" : null;
    if (!sex) throw new HttpError(400, "sex 必须是 male 或 female");
    const heightCm = numOrNull(b.heightCm, "heightCm", 80, 250);
    const birthYear = intOrNull(b.birthYear, "birthYear", 1900, 2100);
    const restHr = intOrNull(b.restHr, "restHr", 30, 150);
    run(
      db,
      `INSERT INTO profile (id, name, sex, birth_year, height_cm, rest_hr, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, sex=excluded.sex,
         birth_year=excluded.birth_year, height_cm=excluded.height_cm,
         rest_hr=excluded.rest_hr, updated_at=excluded.updated_at`,
      String(b.name || "").slice(0, 40),
      sex,
      birthYear,
      heightCm,
      restHr,
      now(),
    );
    return { ok: true };
  });

  // ---------- foods ----------
  route("GET", "/api/foods", (req) => {
    const q = req.query.get("q") || "";
    const limit = Math.min(Number(req.query.get("limit")) || 20, 100);
    return {
      foods: searchFoods(foods, q, limit).map(publicFood),
      total: foods.foods.length,
      source: foods.meta.source,
      notes: foods.meta.notes,
    };
  });

  route("GET", "/api/foods/:id", (req) => {
    const food = foods.byId.get(req.params.id);
    if (!food) throw new HttpError(404, "没有这个食物");
    return { food: publicFood(food) };
  });

  // ---------- meals ----------
  route("GET", "/api/days/:date", (req) => {
    const date = requireDate(req.params.date);
    return { day: daySummary(db, date) };
  });

  route("POST", "/api/meals", (req) => {
    const b = req.body || {};
    const date = requireDate(b.date);
    const slot = SLOTS.includes(b.slot) ? b.slot : "snack";
    const food = foods.byId.get(b.foodId);
    if (!food) throw new HttpError(400, "foodId 不在食物库里");
    const grams = Number(b.grams);
    if (!(grams > 0) || grams > 10000) throw new HttpError(400, "重量必须在 0-10000g 之间");
    const components = normalizeComponents(food, b.components);
    const n = entryNutrients(food, components, grams);
    const info = run(
      db,
      `INSERT INTO meals (date, slot, food_id, food_name, grams, components, kcal, carb, protein, fat, alcohol, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      date,
      slot,
      food.id,
      food.name,
      grams,
      JSON.stringify(components),
      n.kcal,
      n.carb,
      n.protein,
      n.fat,
      n.alcohol || 0,
      String(b.note || "").slice(0, 200),
      now(),
    );
    return { ok: true, id: Number(info.lastInsertRowid), nutrients: n };
  });

  route("PUT", "/api/meals/:id", (req) => {
    const id = Number(req.params.id);
    const existing = get(db, "SELECT * FROM meals WHERE id = ?", id);
    if (!existing) throw new HttpError(404, "没有这条记录");
    const b = req.body || {};
    const date = b.date ? requireDate(b.date) : existing.date;
    const slot = SLOTS.includes(b.slot) ? b.slot : existing.slot;
    const food = foods.byId.get(b.foodId || existing.food_id);
    if (!food) throw new HttpError(400, "foodId 不在食物库里");
    const grams = Number(b.grams ?? existing.grams);
    if (!(grams > 0) || grams > 10000) throw new HttpError(400, "重量必须在 0-10000g 之间");
    const components = b.components
      ? normalizeComponents(food, b.components)
      : existing.food_id === food.id
        ? JSON.parse(existing.components)
        : normalizeComponents(food, undefined);
    const n = entryNutrients(food, components, grams);
    run(
      db,
      `UPDATE meals SET date=?, slot=?, food_id=?, food_name=?, grams=?, components=?,
        kcal=?, carb=?, protein=?, fat=?, alcohol=?, note=? WHERE id=?`,
      date,
      slot,
      food.id,
      food.name,
      grams,
      JSON.stringify(components),
      n.kcal,
      n.carb,
      n.protein,
      n.fat,
      n.alcohol || 0,
      String(b.note ?? existing.note).slice(0, 200),
      id,
    );
    return { ok: true, nutrients: n };
  });

  route("DELETE", "/api/meals/:id", (req) => {
    const info = run(db, "DELETE FROM meals WHERE id = ?", Number(req.params.id));
    if (info.changes === 0) throw new HttpError(404, "没有这条记录");
    return { ok: true };
  });

  // ---------- weight ----------
  route("GET", "/api/weights", (req) => {
    const from = req.query.get("from");
    const to = req.query.get("to");
    const rows =
      from && to
        ? all(db, `SELECT date, kg, note FROM weights WHERE ${dateBetween("date")} ORDER BY hex(date)`, from, to)
        : all(db, "SELECT date, kg, note FROM weights ORDER BY date");
    return { weights: rows };
  });

  route("PUT", "/api/weights/:date", (req) => {
    const date = requireDate(req.params.date);
    const b = req.body || {};
    if (b.kg === null || b.kg === "") {
      run(db, `DELETE FROM weights WHERE ${dateEq("date")}`, date);
      return { ok: true };
    }
    const kg = Number(b.kg);
    if (!(kg > 20 && kg < 400)) throw new HttpError(400, "体重必须在 20-400kg 之间");
    run(
      db,
      `INSERT INTO weights (date, kg, note, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET kg=excluded.kg, note=excluded.note`,
      date,
      round(kg, 2),
      String(b.note || "").slice(0, 200),
      now(),
    );
    return { ok: true };
  });

  route("DELETE", "/api/weights/:date", (req) => {
    run(db, `DELETE FROM weights WHERE ${dateEq("date")}`, requireDate(req.params.date));
    return { ok: true };
  });

  // ---------- activity ----------
  route("GET", "/api/activities", (req) => {
    const from = req.query.get("from");
    const to = req.query.get("to");
    const rows =
      from && to
        ? all(db, `SELECT * FROM activities WHERE ${dateBetween("date")} ORDER BY hex(date), id`, from, to)
        : all(db, "SELECT * FROM activities ORDER BY date, id");
    return { activities: rows.map(activityRow) };
  });

  route("POST", "/api/activities", (req) => {
    const b = req.body || {};
    const date = requireDate(b.date);
    const minutes = Number(b.minutes);
    if (!(minutes > 0 && minutes <= 600)) throw new HttpError(400, "时长必须在 0-600 分钟之间");
    const weight = dateWeight(db, date);
    if (!weight) throw new HttpError(400, "请先记录当天的体重，有氧消耗按体重计算");
    const hours = minutes / 60;
    if (b.method === "activity") {
      const item = activitiesData.methodTwo.find(
        (a) => a.group === b.group && a.detail === b.detail,
      );
      if (!item) throw new HttpError(400, "没有这个运动项目");
      const kcal = activityKcal({ weightKg: weight, kcalPerKgHour: item.kcalPerKgHour, hours });
      const info = run(
        db,
        `INSERT INTO activities (date, method, label, minutes, kcal, created_at) VALUES (?, 'activity', ?, ?, ?, ?)`,
        date,
        `${item.group} · ${item.detail}`,
        minutes,
        kcal,
        now(),
      );
      return { ok: true, id: Number(info.lastInsertRowid), kcal };
    }
    const profile = profileWithAge(db, todayLocal());
    const restHr = Number(b.restHr || profile?.restHr);
    const activeHr = Number(b.activeHr);
    if (!(restHr > 30 && restHr < 150)) throw new HttpError(400, "请先在设置里填写静息心率");
    if (!(activeHr > restHr && activeHr < 230)) throw new HttpError(400, "运动心率应高于静息心率");
    const r = hrMethodKcal({ weightKg: weight, restHr, activeHr, hours });
    const info = run(
      db,
      `INSERT INTO activities (date, method, label, minutes, kcal, created_at) VALUES (?, 'hr', ?, ?, ?, ?)`,
      date,
      `心率法 静息${restHr}/运动${activeHr}`,
      minutes,
      r.kcal,
      now(),
    );
    return { ok: true, id: Number(info.lastInsertRowid), kcal: r.kcal, warning: r.valid ? undefined : r.message };
  });

  route("DELETE", "/api/activities/:id", (req) => {
    const info = run(db, "DELETE FROM activities WHERE id = ?", Number(req.params.id));
    if (info.changes === 0) throw new HttpError(404, "没有这条记录");
    return { ok: true };
  });

  route("GET", "/api/activity-table", () => activitiesData);

  // ---------- trend / summary ----------
  route("GET", "/api/trend", (req) => {
    const endDate = requireDate(req.query.get("endDate") || todayLocal());
    const windowDays = Number(req.query.get("window")) || 14;
    return { report: trendReport(db, { endDate, windowDays, today: todayLocal() }) };
  });

  route("GET", "/api/weekly", (req) => {
    const endDate = requireDate(req.query.get("endDate") || todayLocal());
    const weeks = [];
    for (let i = 5; i >= 0; i -= 1) {
      const to = isoAdd(endDate, -7 * i);
      const from = isoAdd(to, -6);
      const t = get(db, `SELECT COALESCE(SUM(kcal),0) k, COALESCE(SUM(carb),0) c, COALESCE(SUM(protein),0) p, COALESCE(SUM(fat),0) f, COUNT(DISTINCT date) d FROM meals WHERE ${dateBetween("date")}`, from, to);
      const days = t.d || 1;
      const w = get(db, `SELECT AVG(kg) g FROM weights WHERE ${dateBetween("date")}`, from, to);
      weeks.push({
        from,
        to,
        loggedDays: t.d,
        avgKcal: round(t.k / days, 0),
        avgCarb: round(t.c / days, 1),
        avgProtein: round(t.p / days, 1),
        avgFat: round(t.f / days, 1),
        avgWeight: w.g === null ? null : round(w.g, 2),
      });
    }
    return { weeks };
  });

  // ---------- attachments (meal/label photos are records only) ----------
  route("POST", "/api/attachments", async (req) => {
    const b = req.body || {};
    const date = requireDate(b.date);
    const kind = ["meal", "label", "other"].includes(b.kind) ? b.kind : "other";
    const mime = String(b.mime || "");
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(mime)) throw new HttpError(400, "只接受图片文件");
    const base64 = String(b.data || "").replace(/^data:[^,]*,/, "");
    const buf = Buffer.from(base64, "base64");
    if (buf.length === 0 || buf.length > 12 * 1024 * 1024) throw new HttpError(400, "图片大小必须在 12MB 以内");
    const id = randomUUID();
    const storageName = `${id}${extname(String(b.fileName || "")).toLowerCase() || "." + mime.split("/")[1]}`;
    await writeFile(join(uploadDir, storageName), buf);
    const info = run(
      db,
      `INSERT INTO attachments (date, kind, file_name, mime, storage_name, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      date,
      kind,
      String(b.fileName || storageName).slice(0, 120),
      mime,
      storageName,
      "仅作记录，不参与热量计算",
      now(),
    );
    return { ok: true, id: Number(info.lastInsertRowid) };
  });

  route("GET", "/api/attachments/:id/file", async (req, res) => {
    const row = get(db, "SELECT * FROM attachments WHERE id = ?", Number(req.params.id));
    if (!row) throw new HttpError(404, "没有这张图片");
    const filePath = join(uploadDir, row.storage_name);
    if (!existsSync(filePath)) throw new HttpError(404, "图片文件已丢失");
    res.writeHead(200, { "Content-Type": row.mime, "Cache-Control": "private, max-age=3600" });
    createReadStream(filePath).pipe(res);
    return HANDLED;
  });

  route("DELETE", "/api/attachments/:id", (req) => {
    run(db, "DELETE FROM attachments WHERE id = ?", Number(req.params.id));
    return { ok: true };
  });

  // ---------- static files ----------
  async function serveStatic(req, res) {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";
    const candidates = [join(ROOT, "public", urlPath), join(ROOT, urlPath)];
    for (const candidate of candidates) {
      const resolved = resolve(candidate);
      if (!resolved.startsWith(ROOT)) continue;
      if (existsSync(resolved) && !isDirectory(resolved)) {
        const type = STATIC_TYPES[extname(resolved)] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
        createReadStream(resolved).pipe(res);
        return;
      }
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const match = routes
        .map((r) => ({ r, m: r.re.exec(url.pathname) }))
        .find((x) => x.m && x.r.method === req.method);
      if (match) {
        const params = {};
        match.r.keys.forEach((k, i) => {
          params[k] = match.m[i + 1];
        });
        const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readJson(req) : null;
        const result = await match.r.handler({ params, body, query: url.searchParams, req }, res);
        if (result === HANDLED) return;
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(result));
        return;
      }
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        await serveStatic(req, res);
        return;
      }
      throw new HttpError(404, "没有这个接口");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err.message, details: err.details }));
    }
  });

  return {
    server,
    db,
    foods,
    listen(port = 8765, host = "127.0.0.1") {
      return new Promise((ok, fail) => {
        server.once("error", fail);
        server.listen(port, host, () => ok(server.address()));
      });
    },
  };
}

const HANDLED = Symbol("handled");

function activityRow(a) {
  return { id: a.id, date: a.date, method: a.method, label: a.label, minutes: a.minutes, kcal: a.kcal };
}

function publicFood(food) {
  return {
    id: food.id,
    name: food.name,
    aliases: food.aliases,
    category: food.category,
    note: food.note,
    components: food.components,
    componentsKeys: Object.keys(food.components),
  };
}

function normalizeComponents(food, provided) {
  const keys = Object.keys(food.components);
  const out = {};
  if (provided && typeof provided === "object" && Object.keys(provided).length > 0) {
    for (const k of keys) {
      const v = Number(provided[k] ?? 0);
      if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `组成项 ${k} 的重量不合法`);
      out[k] = v;
    }
    if (Object.values(out).every((v) => v === 0)) throw new HttpError(400, "组成重量不能全为 0");
    return out;
  }
  return defaultComponents(food);
}

function readJson(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) {
        fail(new HttpError(413, "请求体太大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return ok({});
      try {
        ok(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        fail(new HttpError(400, "请求体不是合法 JSON"));
      }
    });
    req.on("error", fail);
  });
}

function dateWeight(db, date) {
  const row = get(db, `SELECT kg FROM weights WHERE hex(date) <= hex(?) ORDER BY hex(date) DESC LIMIT 1`, date);
  return row ? row.kg : null;
}

function numOrNull(v, name, min, max) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} 必须在 ${min}-${max} 之间`);
  return n;
}

function intOrNull(v, name, min, max) {
  const n = numOrNull(v, name, min, max);
  return n === null ? null : Math.round(n);
}

export { isDate };
