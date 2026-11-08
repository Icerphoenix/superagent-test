// Vanilla single-page UI. No build step: the server serves this directory as-is.

const app = document.getElementById("app");
const toastEl = document.getElementById("toast");

const SLOT_NAMES = { breakfast: "早饭", lunch: "午饭", dinner: "晚饭", snack: "零食/夜宵" };

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let today = localToday();
let state = { date: today, view: "day" };

// ---------- helpers ----------
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function fmt(n, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    toastEl.hidden = true;
  }, 2600);
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseHash() {
  const [view = "day", date] = location.hash.replace(/^#\/?/, "").split("/");
  return { view: ["day", "trend", "history", "settings"].includes(view) ? view : "day", date };
}

// ---------- navigation ----------
document.querySelectorAll(".tabs a").forEach((a) => {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    const tab = a.dataset.tab;
    location.hash = tab === "day" ? `#/day/${state.date}` : `#/${tab}`;
  });
});

window.addEventListener("hashchange", render);

async function render() {
  const h = parseHash();
  state.view = h.view;
  if (h.date && /^\d{4}-\d{2}-\d{2}$/.test(h.date)) state.date = h.date;
  document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === h.view));
  app.innerHTML = '<p class="empty">加载中…</p>';
  try {
    if (h.view === "day") await renderDay();
    else if (h.view === "trend") await renderTrend();
    else if (h.view === "history") await renderHistory();
    else await renderSettings();
  } catch (err) {
    app.innerHTML = "";
    app.append(el(`<div class="notice warn">出错了：${esc(err.message)}</div>`));
  }
}

// ---------- day view ----------
async function renderDay() {
  const date = state.date;
  const [{ day }, profileRes] = await Promise.all([api(`/api/days/${date}`), api("/api/profile")]);
  app.innerHTML = "";

  const head = el(`
    <div class="day-head">
      <h1>${esc(date)}${date === today ? "（今天）" : ""}</h1>
      <div class="day-nav">
        <button data-nav="-1" title="前一天">←</button>
        <input type="date" value="${date}" />
        <button data-nav="1" title="后一天">→</button>
        <button data-nav="0">今天</button>
      </div>
    </div>`);
  head.querySelectorAll("[data-nav]").forEach((b) =>
    b.addEventListener("click", () => {
      const d = Number(b.dataset.nav);
      state.date = d === 0 ? today : addDays(state.date, d);
      location.hash = `#/day/${state.date}`;
    }),
  );
  head.querySelector("input").addEventListener("change", (e) => {
    state.date = e.target.value;
    location.hash = `#/day/${state.date}`;
  });
  app.append(head);

  const t = day.totals;
  const stats = el(`
    <div class="totals">
      <div class="stat"><div class="label">热量</div><div class="value">${fmt(t.kcal)}<span class="unit">kcal</span></div>
        <div class="hint">${day.loggedMeals ? `${day.loggedMeals} 条记录` : "还没有记录"}</div></div>
      <div class="stat"><div class="label">碳水</div><div class="value">${fmt(t.carb, 0)}<span class="unit">g</span></div>
        <div class="hint">${fmt(t.carb * 4)} kcal</div></div>
      <div class="stat"><div class="label">蛋白质</div><div class="value">${fmt(t.protein, 0)}<span class="unit">g</span></div>
        <div class="hint">${fmt(t.protein * 4)} kcal</div></div>
      <div class="stat"><div class="label">脂肪</div><div class="value">${fmt(t.fat, 1)}<span class="unit">g</span></div>
        <div class="hint">${fmt(t.fat * 9)} kcal</div></div>
    </div>`);
  app.append(stats);
  if (!profileRes.profile) {
    app.append(
      el(`<div class="notice info">第一次用？先到 <a href="#/settings">设置</a> 里填身高、性别、出生年份和静息心率，趋势页才能把“记录的热量”和“体重变化”对上。</div>`),
    );
  }

  app.append(buildAddMealCard(date));

  const mealsCard = el(`<div class="card"><h2>今日饮食</h2><div id="slots"></div></div>`);
  app.append(mealsCard);
  const slots = mealsCard.querySelector("#slots");
  for (const slot of Object.keys(SLOT_NAMES)) {
    const s = day.bySlot[slot];
    const box = el(`
      <div class="slot">
        <div class="slot-head">
          <span class="name">${SLOT_NAMES[slot]}</span>
          <span class="sum">${fmt(s.totals.kcal)} kcal · 碳${fmt(s.totals.carb, 0)} 蛋${fmt(s.totals.protein, 0)} 脂${fmt(s.totals.fat, 0)}</span>
        </div>
        ${s.items.length === 0 ? '<div class="muted small">—</div>' : ""}
        <table class="plain"><tbody>
          ${s.items
            .map(
              (m) => `<tr class="item">
                <td>${esc(m.foodName)}</td>
                <td class="num">${fmt(m.grams, 0)}g</td>
                <td class="num">${fmt(m.kcal)}</td>
                <td class="num small muted">碳${fmt(m.carb, 1)} 蛋${fmt(m.protein, 1)} 脂${fmt(m.fat, 1)}</td>
                <td class="num"><button class="ghost" data-del="${m.id}" title="删除">删除</button></td>
              </tr>`,
            )
            .join("")}
        </tbody></table>
      </div>`);
    slots.append(box);
  }
  slots.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/api/meals/${b.dataset.del}`, { method: "DELETE" });
      toast("已删除");
      render();
    }),
  );

  app.append(buildWeightCard(date, day.weight));
  app.append(buildActivityCard(date, day, profileRes.profile));
  app.append(buildPhotoCard(date, day.attachments));
  wireUpload(date);
}

function buildAddMealCard(date) {
  const card = el(`
    <div class="card">
      <h2>记录饮食</h2>
      <p class="sub small" style="margin-bottom:10px">重量来自食物称，不做估算。食物库来自套表「19日常食物营养率」。</p>
      <form class="inline" id="meal-form" autocomplete="off">
        <input type="search" id="food-q" placeholder="搜索食物，如 米饭 / 鸡蛋 / 鸡胸肉" style="min-width:260px" />
        <select id="meal-slot">
          ${Object.entries(SLOT_NAMES).map(([k, v]) => `<option value="${k}"${k === guessSlot() ? " selected" : ""}>${v}</option>`).join("")}
        </select>
      </form>
      <div id="food-results" class="results" hidden></div>
      <div id="picked" hidden></div>
    </div>`);
  const q = card.querySelector("#food-q");
  const results = card.querySelector("#food-results");
  const picked = card.querySelector("#picked");

  let timer = null;
  q.addEventListener("input", () => {
    clearTimeout(timer);
    const term = q.value.trim();
    if (!term) {
      results.hidden = true;
      return;
    }
    timer = setTimeout(async () => {
      const { foods } = await api(`/api/foods?q=${encodeURIComponent(term)}&limit=15`);
      results.hidden = false;
      results.innerHTML = "";
      if (foods.length === 0) {
        results.append(el('<div class="empty small">没有找到。换个叫法试试，比如“熟米饭”“鸡胸肉”。</div>'));
        return;
      }
      for (const f of foods) {
        const main = f.components.self?.per100g;
        const kcal = main ? main.kcal : null;
        const b = el(`<button type="button">
          <div>${esc(f.name)} <span class="meta">· ${esc(f.category)}</span></div>
          <div class="meta">${kcal === null ? "" : `每100g ${fmt(kcal)} kcal · 碳${fmt(main.carb)} 蛋${fmt(main.protein)} 脂${fmt(main.fat)}`}</div>
        </button>`);
        b.addEventListener("click", () => {
          results.hidden = true;
          showPicked(f);
        });
        results.append(b);
      }
    }, 150);
  });

  function showPicked(food) {
    const comps = food.componentsKeys;
    const per = food.components;
    picked.hidden = false;
    picked.innerHTML = "";
    const form = el(`
      <form class="inline" id="add-form" style="margin-top:10px">
        <strong style="min-width:120px">${esc(food.name)}</strong>
        <label class="field"><span>实际重量</span><input type="number" id="g" min="1" step="1" value="${suggestGrams(food)}" style="width:110px" required /> </label>
        <span class="small">g</span>
        ${comps.length > 1 ? comps.map((k, i) => `<label class="field"><span>${esc(componentLabel(food, k))}占比</span><input type="number" class="share" data-k="${k}" min="0" step="1" value="${Math.round(100 / comps.length)}" style="width:70px" /></label>`).join("") : ""}
        <label class="field"><span>备注</span><input type="text" id="meal-note" maxlength="60" placeholder="可选" style="width:140px" /></label>
        <button class="primary" type="submit">加入</button>
        <button type="button" id="cancel">取消</button>
        <span id="preview" class="small muted"></span>
      </form>
      <details style="margin-top:6px"><summary>营养率说明</summary><div class="small">${esc(food.note || "")}<br/>${comps
        .map((k) => `${esc(componentLabel(food, k))}：每100g ${fmt(per[k].per100g.kcal)} kcal，碳水${fmt(per[k].per100g.carb)}g 蛋白质${fmt(per[k].per100g.protein)}g 脂肪${fmt(per[k].per100g.fat)}g（${esc(per[k].basis)}）`)
        .join("<br/>")}</div></details>`);
    picked.append(form);
    const g = form.querySelector("#g");
    const preview = form.querySelector("#preview");
    const componentInputs = [...form.querySelectorAll(".share")];
    // Keep the component shares (e.g. oatmeal vs milk weights) summing to 100 so
    // the gram input always means the real, weighed total.
    componentInputs.forEach((input) => {
      input.addEventListener("input", () => {
        const others = componentInputs.filter((x) => x !== input);
        const rest = 100 - Number(input.value || 0);
        const otherSum = others.reduce((a, x) => a + Number(x.value || 0), 0) || others.length;
        others.forEach((x) => {
          const next = others.length === 1 ? rest : (rest * Number(x.value || 0)) / otherSum;
          x.value = Math.max(0, Math.round(next));
        });
      });
    });
    const updatePreview = () => {};
    g.addEventListener("input", updatePreview);
    form.querySelector("#cancel").addEventListener("click", () => {
      picked.hidden = true;
      q.value = "";
      q.focus();
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const components = {};
      form.querySelectorAll(".share").forEach((s) => (components[s.dataset.k] = Number(s.value)));
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const r = await api("/api/meals", {
          method: "POST",
          body: {
            date,
            slot: card.querySelector("#meal-slot").value,
            foodId: food.id,
            grams: Number(g.value),
            components: Object.keys(components).length ? components : undefined,
            note: form.querySelector("#meal-note").value,
          },
        });
        toast(`已加入 ${fmt(r.nutrients.kcal)} kcal`);
        render();
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    });
  }

  return card;
}

function componentLabel(food, key) {
  const basis = food.components[key]?.basis;
  const names = { self: food.name };
  return names[key] || `${key}${basis ? `（${basis}）` : ""}`;
}

function suggestGrams(food) {
  const map = {
    rice: 150, rice_hard: 150, rice_soft: 200, mantou: 100, bread_slice: 35, egg: 50, milk: 250,
    meat_cooked: 100, takeaway_rice_box: 330, takeaway_rice_round: 300, oat_flake: 50, oat_bran: 40,
    sweet_potato: 150, potato: 150, sweet_corn: 200, banana: 120, apple: 180, vegetable: 200,
  };
  return map[food.id] || 100;
}

function guessSlot() {
  const h = new Date().getHours();
  if (h < 10) return "breakfast";
  if (h < 15) return "lunch";
  if (h < 21) return "dinner";
  return "snack";
}

function buildWeightCard(date, weight) {
  const card = el(`
    <div class="card">
      <h2>体重</h2>
      <p class="sub small">每天早上起床排尿后、早饭前称一次即可。单日体重会被食糜和水分影响，趋势页才看趋势。</p>
      <form class="inline" id="w-form">
        <input type="number" id="w-kg" step="0.1" min="20" max="400" placeholder="kg" value="${weight ? weight.kg : ""}" style="width:110px" />
        <span class="small">kg</span>
        <button class="primary" type="submit">${weight ? "更新" : "记录"}</button>
        ${weight ? '<button type="button" id="w-del">删除</button>' : ""}
      </form>
    </div>`);
  card.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api(`/api/weights/${date}`, { method: "PUT", body: { kg: Number(card.querySelector("#w-kg").value) } });
      toast("已记录体重");
      render();
    } catch (err) {
      toast(err.message);
    }
  });
  card.querySelector("#w-del")?.addEventListener("click", async () => {
    await api(`/api/weights/${date}`, { method: "PUT", body: { kg: null } });
    render();
  });
  return card;
}

function buildActivityCard(date, day, profile) {
  const card = el(`
    <div class="card">
      <h2>有氧</h2>
      <p class="sub small">来自套表「16有氧热量消耗」，按当日最近一次体重换算。减脂建议心率约 120 次/分。</p>
      <form class="inline" id="a-form">
        <select id="a-method">
          <option value="activity">按运动项目</option>
          <option value="hr">按心率</option>
        </select>
        <span id="a-activity">
          <select id="a-group"></select>
          <select id="a-detail"></select>
        </span>
        <span id="a-hr" hidden>
          <input type="number" id="a-rest" placeholder="静息心率" value="${profile?.restHr ?? ""}" style="width:100px" min="30" max="150" />
          <input type="number" id="a-active" placeholder="运动心率" style="width:100px" min="60" max="220" />
        </span>
        <input type="number" id="a-min" min="1" max="600" placeholder="分钟" style="width:90px" required />
        <button class="primary" type="submit">加入</button>
        <span class="small muted" id="a-kcal"></span>
      </form>
      <ul class="tight small" id="a-list">
        ${day.activities.map((a) => `<li>${esc(a.label)} · ${fmt(a.minutes)} 分钟 · ${fmt(a.kcal)} kcal <button class="ghost" data-del-a="${a.id}">删除</button></li>`).join("")}
      </ul>
    </div>`);
  const groupSel = card.querySelector("#a-group");
  const detailSel = card.querySelector("#a-detail");
  const methodSel = card.querySelector("#a-method");
  let table = null;
  api("/api/activity-table").then((t) => {
    table = t;
    const groups = [...new Set(t.methodTwo.map((x) => x.group))];
    groupSel.innerHTML = groups.map((g) => `<option>${esc(g)}</option>`).join("");
    fillDetails();
  });
  function fillDetails() {
    if (!table) return;
    const items = table.methodTwo.filter((x) => x.group === groupSel.value);
    detailSel.innerHTML = items.map((x) => `<option value="${esc(x.detail)}">${esc(x.detail)}（${x.kcalPerKgHour} kcal/kg/时）</option>`).join("");
  }
  groupSel.addEventListener("change", fillDetails);
  methodSel.addEventListener("change", () => {
    card.querySelector("#a-activity").hidden = methodSel.value !== "activity";
    card.querySelector("#a-hr").hidden = methodSel.value !== "hr";
  });
  card.querySelector("#a-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const body = { date, minutes: Number(card.querySelector("#a-min").value) };
      if (methodSel.value === "hr") {
        body.method = "hr";
        body.restHr = Number(card.querySelector("#a-rest").value) || undefined;
        body.activeHr = Number(card.querySelector("#a-active").value);
      } else {
        body.method = "activity";
        body.group = groupSel.value;
        body.detail = detailSel.value;
      }
      const r = await api("/api/activities", { method: "POST", body });
      toast(`已加入 ${r.kcal} kcal 有氧${r.warning ? `（${r.warning}）` : ""}`);
      render();
    } catch (err) {
      toast(err.message);
    }
  });
  card.querySelectorAll("[data-del-a]").forEach((b) =>
    b.addEventListener("click", async () => {
      await api(`/api/activities/${b.dataset.delA}`, { method: "DELETE" });
      render();
    }),
  );
  return card;
}

function buildPhotoCard(date, attachments) {
  const card = el(`
    <div class="card">
      <h2>照片（仅作记录）</h2>
      <p class="sub small">餐食照片、配料表照片只留档，不参与热量计算——视觉估重会得到假精确的数字。</p>
      <input type="file" id="photo" accept="image/*" />
      <div class="photo-row">
        ${attachments
          .map(
            (a) => `<figure style="margin:0;position:relative"><img src="/api/attachments/${a.id}/file" alt="${esc(a.file_name)}" loading="lazy" /><figcaption class="small muted" style="width:96px">${esc(a.kind === "label" ? "配料表" : "餐食")}</figcaption></figure>`,
          )
          .join("")}
      </div>
    </div>`);
  return card;
}

function wireUpload(date) {
  const input = document.getElementById("photo");
  if (!input) return;
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) return toast("图片太大（上限 12MB）");
    const data = await new Promise((ok) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result));
      r.readAsDataURL(file);
    });
    try {
      await api("/api/attachments", {
        method: "POST",
        body: { date, kind: file.type ? "meal" : "other", fileName: file.name, mime: file.type, data },
      });
      toast("照片已保存");
      render();
    } catch (err) {
      toast(err.message);
    }
  });
}

// ---------- trend view ----------
async function renderTrend() {
  const endDate = state.date || today;
  const [{ report }, { weeks }] = await Promise.all([
    api(`/api/trend?endDate=${endDate}&window=14`),
    api(`/api/weekly?endDate=${endDate}`),
  ]);
  app.innerHTML = "";
  app.append(
    el(`<div class="day-head"><h1>趋势</h1><span class="muted">截至 ${esc(endDate)} 的最近 14 天</span></div>`),
  );

  const t = report.trend;
  const c = report.comparison;
  app.append(
    el(`<div class="notice plain">单日、两三天的体重变化主要来自食糜和水分（套表「17减脂-问答汇总」问答20）。这里的结论都基于 1-2 周的平滑趋势；单一数据点不代表什么。</div>`),
  );

  const card = el(`<div class="card" style="margin-top:16px">
    <h2>体重趋势</h2>
    ${
      t.status === "ok"
        ? `<div class="big-number">${t.weeklyKg > 0 ? "+" : ""}${fmt(t.weeklyKg, 2)} kg / 周</div>
           <div class="range">趋势区间 ${t.weeklyKgRange ? `${fmt(t.weeklyKgRange[0], 2)} ~ ${fmt(t.weeklyKgRange[1], 2)}` : "样本不足"} kg/周；窗口内平滑趋势 ${fmt(t.trendStart, 1)} → ${fmt(t.trendEnd, 1)} kg（${t.trendChange > 0 ? "+" : ""}${fmt(t.trendChange, 1)} kg）</div>`
        : `<div class="notice warn" style="margin-top:0">${esc(t.message)}</div>`
    }
    <div class="chart-wrap" style="margin-top:12px"><canvas id="wchart"></canvas></div>
    <p class="small muted">实线是平滑趋势，圆点是实际称重。只看圆点上下跳动，很容易被误导。</p>
  </div>`);
  app.append(card);

  if (t.series && t.series.length) {
    drawWeightChart(card.querySelector("#wchart"), t.series);
  }

  const e = report.energy;
  app.append(
    el(`<div class="card"><h2>这段时间吃进去 vs 预计消耗</h2>
      ${
        e.status === "ok"
          ? `<dl class="kv">
              <dt>记录的平均摄入</dt><dd>${fmt(e.avgIntakeKcal)} kcal/天（有记录的 ${report.coverage.mealDays} 天）</dd>
              <dt>预计维持热量</dt><dd>${fmt(e.maintenanceKcal)} kcal/天（基础代谢按 ${fmt(report.profile?.referenceWeightKg ?? 0, 1)}kg 算，含日常活动 + 食物热效应）</dd>
              <dt>有氧消耗</dt><dd>${fmt(e.activityKcalPerDay)} kcal/天</dd>
              <dt>平均热量赤字</dt><dd>${fmt(e.avgDeficitKcal)} kcal/天</dd>
              <dt>按赤字推算</dt><dd>${fmt(e.predictedWeeklyKg, 2)} kg/周（7700 kcal ≈ 1kg 脂肪）</dd>
            </dl>`
          : `<div class="notice warn" style="margin-top:0">${esc(e.message)}</div>`
      }
    </div>`),
  );

  app.append(
    el(`<div class="card"><h2>两者对得上吗</h2>
      ${c.status === "ok"
        ? `<div class="notice ${c.consistent ? "info" : "warn"}" style="margin-top:0">${esc(c.message)}</div>
           <dl class="kv" style="margin-top:10px">
             <dt>体重趋势</dt><dd>${fmt(c.observedWeeklyKg, 2)} kg/周</dd>
             <dt>记录推算</dt><dd>${fmt(c.predictedWeeklyKg, 2)} kg/周</dd>
             <dt>差值</dt><dd>${c.gapWeeklyKg > 0 ? "+" : ""}${fmt(c.gapWeeklyKg, 2)} kg/周（容差 ±${fmt(c.tolerance, 2)}）</dd>
           </dl>`
        : `<div class="notice warn" style="margin-top:0">${esc(c.message)}</div>`}
      <p class="small muted">脂肪一列在原表里本来就是文字指导（不细算），所以热量数字会有偏差；这里只用它判断趋势是否合理，不用来替代称重。</p>
    </div>`),
  );

  app.append(
    el(`<div class="card"><h2>按周汇总</h2>
      <table class="plain"><thead><tr><th>周</th><th class="num">记录天数</th><th class="num">平均热量</th><th class="num">碳</th><th class="num">蛋</th><th class="num">脂</th><th class="num">平均体重</th></tr></thead>
      <tbody>${weeks
        .map(
          (w) => `<tr><td>${w.from} ~ ${w.to}</td><td class="num">${w.loggedDays}</td><td class="num">${w.loggedDays ? fmt(w.avgKcal) : "—"}</td><td class="num">${w.loggedDays ? fmt(w.avgCarb) : "—"}</td><td class="num">${w.loggedDays ? fmt(w.avgProtein) : "—"}</td><td class="num">${w.loggedDays ? fmt(w.avgFat) : "—"}</td><td class="num">${fmt(w.avgWeight, 1)}</td></tr>`,
        )
        .join("")}</tbody></table>
    </div>`),
  );
}

function drawWeightChart(canvas, series) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = rect.height;
  const pad = { l: 44, r: 12, t: 12, b: 26 };
  const vals = series.flatMap((p) => (p.measured !== null ? [p.measured, p.trend] : [p.trend]));
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (max - min < 1) {
    min -= 0.5;
    max += 0.5;
  }
  const y = (v) => pad.t + ((max - v) / (max - min)) * (H - pad.t - pad.b);
  const x = (i) => pad.l + (i / Math.max(series.length - 1, 1)) * (W - pad.l - pad.r);

  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "#e2e0d8";
  ctx.fillStyle = "#6b736e";
  ctx.font = "11px 'Noto Sans SC', system-ui, sans-serif";
  const ticks = 4;
  for (let i = 0; i <= ticks; i += 1) {
    const v = min + ((max - min) * i) / ticks;
    const yy = y(v);
    ctx.beginPath();
    ctx.moveTo(pad.l, yy);
    ctx.lineTo(W - pad.r, yy);
    ctx.stroke();
    ctx.fillText(`${v.toFixed(1)}`, 6, yy + 4);
  }
  const labels = [0, Math.floor(series.length / 2), series.length - 1];
  for (const i of labels) {
    const lab = series[i].date.slice(5);
    ctx.fillText(lab, Math.min(Math.max(x(i) - 14, pad.l), W - pad.r - 24), H - 8);
  }

  ctx.beginPath();
  series.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.trend)) : ctx.moveTo(x(i), y(p.trend))));
  ctx.strokeStyle = "#2f6f4f";
  ctx.lineWidth = 2;
  ctx.stroke();

  series.forEach((p, i) => {
    if (p.measured === null) return;
    ctx.beginPath();
    ctx.arc(x(i), y(p.measured), 3, 0, Math.PI * 2);
    ctx.fillStyle = "#a8611c";
    ctx.fill();
  });
}

// ---------- history view ----------
async function renderHistory() {
  const { weights } = await api("/api/weights");
  app.innerHTML = "";
  app.append(el(`<div class="day-head"><h1>历史</h1><span class="muted">共 ${weights.length} 次称重</span></div>`));
  app.append(
    el(`<div class="card"><h2>体重记录</h2>
      ${weights.length === 0
        ? '<div class="empty">还没有体重记录</div>'
        : `<table class="plain"><thead><tr><th>日期</th><th class="num">kg</th><th>备注</th></tr></thead><tbody>${weights
            .slice()
            .reverse()
            .map((w) => `<tr><td>${w.date}</td><td class="num">${fmt(w.kg, 1)}</td><td>${esc(w.note || "")}</td></tr>`)
            .join("")}</tbody></table>`}
    </div>`),
  );
}

// ---------- settings ----------
async function renderSettings() {
  const { profile } = await api("/api/profile");
  app.innerHTML = "";
  app.append(el(`<div class="day-head"><h1>设置</h1></div>`));
  const p = profile || {};
  const card = el(`<div class="card">
    <h2>个人资料</h2>
    <p class="sub small">只用来把热量和体重趋势对上（Mifflin-St Jeor 公式），不做自动配额。</p>
    <form id="p-form" class="grid two" style="gap:12px">
      <label class="field"><span>性别</span>
        <select name="sex"><option value="male"${p.sex !== "female" ? " selected" : ""}>男</option><option value="female"${p.sex === "female" ? " selected" : ""}>女</option></select>
      </label>
      <label class="field"><span>身高 (cm)</span><input name="heightCm" type="number" min="80" max="250" step="0.5" value="${p.heightCm ?? ""}" /></label>
      <label class="field"><span>出生年份</span><input name="birthYear" type="number" min="1900" max="2100" value="${p.birthYear ?? ""}" /></label>
      <label class="field"><span>静息心率（早上安静时，可空）</span><input name="restHr" type="number" min="30" max="150" value="${p.restHr ?? ""}" /></label>
      <button class="primary" type="submit">保存</button>
    </form>
  </div>`);
  app.append(card);
  card.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api("/api/profile", {
        method: "PUT",
        body: {
          sex: fd.get("sex"),
          heightCm: fd.get("heightCm") || null,
          birthYear: fd.get("birthYear") || null,
          restHr: fd.get("restHr") || null,
        },
      });
      toast("已保存");
    } catch (err) {
      toast(err.message);
    }
  });

  app.append(
    el(`<div class="card"><h2>关于数据</h2>
      <ul class="tight">
        <li>所有数据存在本机的一个 SQLite 文件里（默认 <code>data/db.sqlite</code>），不发往任何服务器。</li>
        <li>食物营养率来自《健身Excel超级套表》作者：B站好人松松，工作表「19日常食物营养率」。</li>
        <li>有氧消耗来自「16有氧热量消耗」；体重比较的周期原则来自「17减脂-问答汇总」问答20。</li>
        <li>原表明确建议不细算脂肪、并排除高脂肉和糖油混合物；本软件为了给出趋势而记录脂肪，数值有偏差时以趋势为准。</li>
      </ul>
    </div>`),
  );
}

today = localToday();
render();
