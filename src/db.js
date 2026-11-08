// Single-person local storage. One SQLite file, no users, no cloud sync.
// Uses the built-in node:sqlite module so the app installs with zero native
// build steps on Windows (no better-sqlite3 / node-gyp).

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT '',
  sex TEXT NOT NULL CHECK (sex IN ('male','female')),
  birth_year INTEGER,
  height_cm REAL,
  rest_hr INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('breakfast','lunch','dinner','snack')),
  food_id TEXT,
  food_name TEXT NOT NULL,
  grams REAL NOT NULL CHECK (grams > 0),
  components TEXT NOT NULL,
  kcal REAL NOT NULL,
  carb REAL NOT NULL,
  protein REAL NOT NULL,
  fat REAL NOT NULL,
  alcohol REAL NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meals_date ON meals(date);

CREATE TABLE IF NOT EXISTS weights (
  date TEXT PRIMARY KEY,
  kg REAL NOT NULL CHECK (kg > 0),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('activity','hr')),
  label TEXT NOT NULL,
  minutes REAL NOT NULL,
  kcal REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(date);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('meal','label','other')),
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  storage_name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_date ON attachments(date);
`;

export function openDatabase(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

// Dates are compared in SQL, so the comparison must not depend on how the
// driver renders a bound value: we pass the calendar date back as its hex
// bytes and match `hex(date) = hex(?)` for exact lookups and
// `hex(date) BETWEEN hex(?) AND hex(?)` for ranges (hex order == byte order).
const DATE_HEX = (column) => `hex(${column})`;

export function all(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

export function get(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

export function run(db, sql, ...params) {
  return db.prepare(sql).run(...params);
}

/** Calendar-date comparisons that are stable for any bound representation. */
export const dateEq = (column) => `${DATE_HEX(column)} = hex(?)`;
export const dateBetween = (column) => `${DATE_HEX(column)} BETWEEN hex(?) AND hex(?)`;
