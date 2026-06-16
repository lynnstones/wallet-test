import { Chart, registerables } from 'chart.js';
import ChartDataLabels from 'chartjs-plugin-datalabels';

Chart.register(...registerables, ChartDataLabels);

export const categoryConfig = {
  餐饮: { emoji: "🍜", chartColor: "#f97316" },
  交通: { emoji: "🚗", chartColor: "#3b82f6" },
  购物: { emoji: "🛍️", chartColor: "#ec4899" },
  娱乐: { emoji: "🎮", chartColor: "#8b5cf6" },
  医疗: { emoji: "💊", chartColor: "#10b981" },
  居家: { emoji: "🏠", chartColor: "#f59e0b" },
  通讯: { emoji: "📱", chartColor: "#06b6d4" },
  其他: { emoji: "📦", chartColor: "#94a3b8" },
};
export const formatMoney = v => "¥ " + Number(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const getDateKey  = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

// ── 图表实例 & 穿透状态 ───────────────────────────────
const C = { spending: null, weekly: null, weeklyHist: null };
let _drillCat = null;

// 将 hex 颜色与白色按比例混合，t=1 为原色，t=0 为纯白
const hexMix = (hex, t) => {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgb(${Math.round(255+(r-255)*t)},${Math.round(255+(g-255)*t)},${Math.round(255+(b-255)*t)})`;
};

// 返回按钮（单例，延迟插入 DOM）
let _backBtn = null;
function ensureBackBtn() {
  if (_backBtn) return _backBtn;
  _backBtn = document.createElement("button");
  _backBtn.type = "button";
  _backBtn.className = "hidden items-center gap-1.5 text-xs font-medium text-slate-500 bg-white/80 backdrop-blur-sm rounded-full px-3 py-1.5 border border-slate-200 shadow-sm transition hover:text-slate-800 hover:bg-white active:scale-95 mb-3 self-start";
  _backBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>返回全部分类`;
  _backBtn.addEventListener("click", () => { _drillCat = null; updateChart(); });
  const chartWrap = document.getElementById("chartWrap");
  chartWrap?.parentElement?.insertBefore(_backBtn, chartWrap);
  return _backBtn;
}

// ── 饼图：本月支出分布（含分类穿透） ─────────────────
export function updateChart() {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  const monthExpenses = window.AppStore.expenses
    .filter(e => { const d = new Date(e.timestamp); return d.getFullYear() === y && d.getMonth() === m; });

  const chartWrap  = document.getElementById("chartWrap");
  const chartEmpty = document.getElementById("chartEmpty");
  const canvas     = document.getElementById("spendingChart");
  const centerEl   = document.getElementById("chartCenterAmount");
  const legendEl   = document.getElementById("chartLegend");

  // ── 二级穿透视图 ──────────────────────────────────
  if (_drillCat) {
    const items = monthExpenses.filter(e => (e.category || "其他") === _drillCat);
    if (!items.length) {
      _drillCat = null; // 分类已无数据，回退到总览
    } else {
      ensureBackBtn().classList.replace("hidden", "flex") || ensureBackBtn().classList.add("flex");

      const sorted     = [...items].sort((a, b) => Number(b.amount) - Number(a.amount));
      const base       = (categoryConfig[_drillCat] || categoryConfig["其他"]).chartColor;
      const n          = sorted.length;
      const labels     = sorted.map(e => e.name.length > 9 ? e.name.slice(0, 8) + "…" : e.name);
      const values     = sorted.map(e => Number(e.amount));
      const colors     = sorted.map((_, i) => hexMix(base, 1 - (i / Math.max(n - 1, 1)) * 0.52));
      const total      = values.reduce((a, b) => a + b, 0);
      const cfg        = categoryConfig[_drillCat] || categoryConfig["其他"];

      chartEmpty.classList.add("hidden"); chartEmpty.classList.remove("flex");
      chartWrap.classList.remove("hidden");
      centerEl.textContent = `${cfg.emoji} ${_drillCat}`;
      legendEl.innerHTML = sorted.map((e, i) => {
        const pct = ((values[i] / total) * 100).toFixed(1);
        return `<li class="flex items-center justify-between gap-2">
          <span class="flex items-center gap-2 text-sm text-slate-700 min-w-0">
            <span class="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style="background:${colors[i]}"></span>
            <span class="truncate">${e.name}</span>
          </span>
          <span class="shrink-0 text-xs text-slate-500">¥ ${values[i].toLocaleString("zh-CN", { maximumFractionDigits: 0 })} <span class="text-slate-400">(${pct}%)</span></span>
        </li>`;
      }).join("");

      if (C.spending) {
        C.spending.data.labels = labels;
        C.spending.data.datasets[0].data = values;
        C.spending.data.datasets[0].backgroundColor = colors;
        C.spending.update("active");
      }
      return;
    }
  }

  // ── 一级总览视图 ──────────────────────────────────
  const btn = ensureBackBtn();
  btn.classList.add("hidden"); btn.classList.remove("flex");

  const totals = {};
  monthExpenses.forEach(e => { const c = e.category || "其他"; totals[c] = (totals[c] || 0) + Number(e.amount); });

  const cats       = Object.keys(totals).filter(k => totals[k] > 0);
  const values     = cats.map(k => totals[k]);
  const colors     = cats.map(k => (categoryConfig[k] || categoryConfig["其他"]).chartColor);
  const grandTotal = values.reduce((a, b) => a + b, 0);

  if (!cats.length) {
    chartWrap.classList.add("hidden");
    chartEmpty.classList.remove("hidden"); chartEmpty.classList.add("flex");
    if (C.spending) { C.spending.destroy(); C.spending = null; }
    return;
  }

  chartEmpty.classList.add("hidden"); chartEmpty.classList.remove("flex");
  chartWrap.classList.remove("hidden");
  centerEl.textContent = "¥ " + grandTotal.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
  legendEl.innerHTML = cats.map((cat, i) => {
    const pct = ((values[i] / grandTotal) * 100).toFixed(1);
    return `<li class="flex items-center justify-between gap-2">
      <span class="flex items-center gap-2 text-sm text-slate-700">
        <span class="inline-block h-2.5 w-2.5 rounded-full shrink-0" style="background:${colors[i]}"></span>${cat}
      </span>
      <span class="text-xs text-slate-500">¥ ${values[i].toLocaleString("zh-CN", { maximumFractionDigits: 0 })} <span class="text-slate-400">(${pct}%)</span></span>
    </li>`;
  }).join("");

  if (C.spending) {
    C.spending.data.labels = cats;
    C.spending.data.datasets[0].data = values;
    C.spending.data.datasets[0].backgroundColor = colors;
    C.spending.update("active");
  } else {
    C.spending = new Chart(canvas, {
      type: "doughnut",
      data: { labels: cats, datasets: [{ data: values, backgroundColor: colors, borderWidth: 3, borderColor: "rgba(255,255,255,0.85)", hoverOffset: 8 }] },
      options: {
        cutout: "68%",
        animation: { animateRotate: true, duration: 600, easing: "easeInOutQuart" },
        onClick: (_, elements) => {
          if (!elements.length || _drillCat) return;
          _drillCat = C.spending.data.labels[elements[0].index];
          updateChart();
        },
        plugins: {
          legend: { display: false },
          datalabels: { display: false },
          tooltip: {
            backgroundColor: "rgba(255,255,255,0.92)", titleColor: "#0f172a", bodyColor: "#475569",
            borderColor: "rgba(0,0,0,0.06)", borderWidth: 1, padding: 10, cornerRadius: 12,
            callbacks: {
              label: ctx => {
                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                return ` ¥ ${ctx.parsed.toLocaleString("zh-CN", { maximumFractionDigits: 0 })}  (${((ctx.parsed / total) * 100).toFixed(1)}%)`;
              },
            },
          },
        },
      },
    });
  }
}

export function updateMonthlyRanking() {
  const listEl  = document.getElementById("monthlyRankingList");
  const emptyEl = document.getElementById("monthlyRankingEmpty");
  if (!listEl || !emptyEl) return;

  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  const totals = {};
  window.AppStore.expenses
    .filter(e => { const d = new Date(e.timestamp); return d.getFullYear() === y && d.getMonth() === m; })
    .forEach(e => { const c = e.category || "其他"; totals[c] = (totals[c] || 0) + Number(e.amount); });

  const top5 = Object.entries(totals).filter(([, a]) => a > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!top5.length) { listEl.innerHTML = ""; emptyEl.classList.remove("hidden"); return; }

  emptyEl.classList.add("hidden");
  const total5 = top5.reduce((s, [, a]) => s + a, 0);
  const RANK = [
    { bg: "#d97706", color: "#fff", label: "#1" }, { bg: "#64748b", color: "#fff", label: "#2" },
    { bg: "#b45309", color: "#fff", label: "#3" }, { bg: "#e2e8f0", color: "#475569", label: "#4" },
    { bg: "#e2e8f0", color: "#475569", label: "#5" },
  ];
  listEl.innerHTML = top5.map(([cat, amt], i) => {
    const { chartColor } = categoryConfig[cat] || categoryConfig["其他"];
    const pct = total5 > 0 ? (amt / total5) * 100 : 0;
    return `<li class="rounded-2xl border border-slate-100 bg-white/80 px-3.5 py-3">
        <div class="flex items-center justify-between gap-2">
          <span class="flex items-center gap-2.5 min-w-0">
            <span class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
                  style="background:${RANK[i].bg};color:${RANK[i].color}">${RANK[i].label}</span>
            <span class="truncate text-sm font-medium text-slate-700">${cat}</span>
          </span>
          <span class="shrink-0 text-sm font-semibold text-slate-900">${formatMoney(amt)}</span>
        </div>
        <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div class="h-full rounded-full transition-all duration-500 ease-out" style="width:${pct.toFixed(1)}%;background:${chartColor}"></div>
        </div>
      </li>`;
  }).join("");
}

export function buildWeeklyChartConfig(values, xLabels, dayCats) {
  return {
    type: "line",
    data: {
      labels: xLabels,
      datasets: [{
        data: values, dayCats,
        borderColor: "#6366f1", backgroundColor: "rgba(99,102,241,0.07)",
        borderWidth: 2,
        pointBackgroundColor: values.map(v => v > 0 ? "#6366f1" : "rgba(99,102,241,0.25)"),
        pointBorderColor: "#fff", pointBorderWidth: 2, pointRadius: 5, pointHoverRadius: 7,
        fill: true, tension: 0.42,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 700, easing: "easeInOutQuart" },
      layout: { padding: { top: 28 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(255,255,255,0.97)", titleColor: "#0f172a", bodyColor: "#475569",
          borderColor: "rgba(0,0,0,0.08)", borderWidth: 1,
          padding: { top: 10, bottom: 10, left: 12, right: 12 }, cornerRadius: 14,
          callbacks: {
            title:  items => { const l = items[0].label; return Array.isArray(l) ? l.join("  ") : l; },
            label:  ctx   => ctx.parsed.y > 0 ? ` 合计  ¥ ${ctx.parsed.y.toLocaleString("zh-CN", { maximumFractionDigits: 0 })}` : " 当日无消费",
            afterBody(items) {
              const cats = items[0].dataset.dayCats?.[items[0].dataIndex] ?? {};
              const sorted = Object.entries(cats).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
              if (!sorted.length) return [];
              return ["──────────────", ...sorted.map(([cat, amt]) =>
                ` ${categoryConfig[cat]?.emoji ?? "📦"} ${cat}   ¥ ${amt.toLocaleString("zh-CN", { maximumFractionDigits: 0 })}`)];
            },
          },
        },
        datalabels: {
          display: ctx => ctx.dataset.data[ctx.dataIndex] > 0,
          anchor: "end", align: "top", offset: 2,
          color: "#4f46e5", font: { size: 10, weight: "600" },
          formatter: v => v >= 1000 ? "¥" + (v / 1000).toFixed(1) + "k" : "¥" + Math.round(v),
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 10 }, color: "#94a3b8", maxRotation: 0, callback(_, idx) { return xLabels[idx] ?? ""; } },
        },
        y: {
          grid: { color: "rgba(0,0,0,0.04)", drawTicks: false }, border: { display: false },
          ticks: { font: { size: 10 }, color: "#94a3b8", maxTicksLimit: 4,
            callback: v => v === 0 ? "0" : (v >= 1000 ? "¥" + (v / 1000).toFixed(1) + "k" : "¥" + v) },
          beginAtZero: true,
        },
      },
    },
  };
}

export function updateWeeklyChart() {
  const now = new Date(), dow = now.getDay();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
  startOfWeek.setHours(0, 0, 0, 0);

  const DAY_NAMES = ["周一","周二","周三","周四","周五","周六","周日"];
  const values = new Array(7).fill(0);
  const dayCats = Array.from({ length: 7 }, () => ({}));
  const xLabels = [], dayKeys = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(startOfWeek);
    d.setDate(startOfWeek.getDate() + i);
    dayKeys.push(getDateKey(d));
    xLabels.push([DAY_NAMES[i], `${d.getMonth() + 1}/${d.getDate()}`]);
  }
  window.AppStore.expenses.forEach(e => {
    const idx = dayKeys.indexOf(getDateKey(new Date(e.timestamp)));
    if (idx === -1) return;
    const amt = Number(e.amount);
    values[idx] += amt;
    const cat = e.category || "其他";
    dayCats[idx][cat] = (dayCats[idx][cat] || 0) + amt;
  });
  const ptColors = values.map(v => v > 0 ? "#6366f1" : "rgba(99,102,241,0.25)");

  const syncChart = (canvasId, key) => {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (C[key]) {
      const ds = C[key].data.datasets[0];
      C[key].data.labels = xLabels; ds.data = values; ds.dayCats = dayCats; ds.pointBackgroundColor = ptColors;
      C[key].update("active");
    } else {
      C[key] = new Chart(canvas, buildWeeklyChartConfig(values, xLabels, dayCats));
    }
  };
  syncChart("weeklyChart",        "weekly");
  syncChart("weeklyChartHistory", "weeklyHist");
}
