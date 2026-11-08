# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- 本地、单人使用的热量赤字追踪程序（Issue #8 的 MVP）：`npm start` 后在 http://127.0.0.1:8765 打开。
  - 按食物称重量记录早饭/午饭/晚饭/零食，按套表「19日常食物营养率」计算热量、碳水、蛋白质、脂肪（126 种食物，含复合组成与酒精分项）。
  - 每日体重记录；趋势页用 14 天 EWMA + 回归斜率给出 kg/周 及区间，不足 10 天时明确显示「不足」。
  - 记录的热量、按基础代谢推算的维持热量、有氧消耗与体重趋势对照（Mifflin-St Jeor，7700 kcal ≈ 1 kg）。
  - 有氧消耗：心率法（`活动心率/静息心率×6.4-6.2`）与「16有氧热量消耗」项目表。
  - 照片只作留档，不参与任何热量计算；不预设餐次配额，调整建议留到有 1-2 周数据之后。
- 数据存在单个 SQLite 文件（默认 `data/db.sqlite`，WAL），零第三方依赖。
- 测试：`npm test`（单元 + HTTP API，20 个用例）、`npm run test:ui`（无头 Chrome 界面冒烟测试）。
- CONTRIBUTING, testing and licence guidance in the README.
