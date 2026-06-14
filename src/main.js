import './style.css';
import {
  sb, loadExpenseCache, saveExpenseCache,
  loadHistoryCache, saveHistoryCache, clearHistoryCache,
  saveExpenseToCloud, flushPendingUploads,
  fetchFamilyExpenses, deleteExpenseFromCloud,
  fetchFamilyBudget, saveFamilyBudgetToCloud,
  fetchLastMonthTotal, syncFamilyMembers, registerAllLocalFamilies,
} from './db.js';
import { updateChart, updateWeeklyChart, updateMonthlyRanking, categoryConfig, formatMoney, getDateKey } from './charts.js';

// ── window.AppStore 全局状态中心 ──────────────────────
const AS = window.AppStore = { expenses: [], session: null, showToast: null, loadFamilies: null, saveFamilies: null };

const BUDGET_KEY        = "wallet_budget_v1";
const SESSION_KEY       = "wallet_session_v1";
const FAMILIES_KEY      = "wallet_families_v1";
const RECENT_FILTER_KEY = "wallet_recent_filter_bootstrapped_v1";
const SWIPE_MAX = 88, SWIPE_TRIGGER = 56;

let budget                    = (() => { const v = Number(localStorage.getItem(BUDGET_KEY)); return v > 0 ? v : 8000; })();
let totalSpent                = 0;
let recentExpenseFilterMember = null;
let lastMonthTotalCached      = 0;
let realtimeChannel           = null;
let _splashShownAt            = 0;
const deletingExpenseIds      = new Set();

// ── 内联工具（替代已删除的 utils.js） ─────────────────
const currentYM = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`; };
const buildTimestampFromDateInput = val => {
  if (!val) return new Date().toISOString();
  const [y, mo, d] = val.split("-").map(Number), n = new Date();
  return new Date(y, mo-1, d, n.getHours(), n.getMinutes(), n.getSeconds()).toISOString();
};
const animateNumberRaw = (el, target, fmt) => {
  if (!el) return;
  const from = parseFloat(el.textContent.replace(/[^\d.]/g, "")) || 0, t0 = performance.now();
  const tick = t => { const p = Math.min((t-t0)/380,1), ease = 1-Math.pow(1-p,3); el.textContent = fmt(from+(target-from)*ease); if(p<1) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
};
const animateNumber = (el, v) => animateNumberRaw(el, v, n => "¥ " + n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

// ── Toast ─────────────────────────────────────────────
const showToast = (() => {
  let el = null, timer = null;
  return msg => {
    if (!el) { el = document.createElement("div"); el.className = "sync-toast"; document.body.appendChild(el); }
    el.textContent = msg; el.classList.add("show");
    clearTimeout(timer); timer = setTimeout(() => el.classList.remove("show"), 2400);
  };
})();
AS.showToast = showToast;

// ── Session & 家庭数据 ────────────────────────────────
const loadSession    = () => { const r = localStorage.getItem(SESSION_KEY); return r ? JSON.parse(r) : null; };
const saveSession    = s => { AS.session = s; localStorage.setItem(SESSION_KEY, JSON.stringify(s)); };
const clearSession   = () => { AS.session = null; localStorage.removeItem(SESSION_KEY); };
const loadFamiliesData = () => { const r = localStorage.getItem(FAMILIES_KEY); if (r) { const d = JSON.parse(r); if (d?.families) return d; } return { lastFamily: "", families: {} }; };
const saveFamiliesData = d => localStorage.setItem(FAMILIES_KEY, JSON.stringify(d));
AS.loadFamilies = loadFamiliesData;
AS.saveFamilies = saveFamiliesData;

// ── DOM refs ──────────────────────────────────────────
const totalEl         = document.getElementById("monthlyTotal");
const remainingEl     = document.getElementById("remainingBudget");
const fabButton       = document.getElementById("fabButton");
const modal           = document.getElementById("addExpenseModal");
const overlay         = document.getElementById("modalOverlay");
const closeModalBtn   = document.getElementById("closeModal");
const form            = document.getElementById("expenseForm");
const nameInput       = document.getElementById("expenseName");
const amountInput     = document.getElementById("expenseAmount");
const noteInput       = document.getElementById("expenseNote");
const dateInput       = document.getElementById("expenseDate");
const expenseList     = document.getElementById("expenseList");
const clearTodayBtn   = document.getElementById("clearTodayBtn");
const installPrompt   = document.getElementById("installPrompt");
const installAppBtn   = document.getElementById("installAppBtn");
const installHintText = document.getElementById("installHintText");
const loginOverlay    = document.getElementById("loginOverlay");
const loginForm       = document.getElementById("loginForm");
const loginError      = document.getElementById("loginError");
const memberLabel     = document.getElementById("memberLabel");
const logoutBtn       = document.getElementById("logoutBtn");
const syncDot         = document.getElementById("syncDot");
const budgetDisplay   = document.getElementById("budgetDisplay");
const budgetValueEl   = document.getElementById("budgetValue");
const budgetOverlay   = document.getElementById("budgetOverlay");
const budgetInput     = document.getElementById("budgetInput");
const cancelBudgetBtn = document.getElementById("cancelBudgetBtn");
const saveBudgetBtn   = document.getElementById("saveBudgetBtn");
let deferredInstallPrompt = null;

// ── 摘要卡片 ──────────────────────────────────────────
function updateSummary() {
  animateNumber(totalEl, totalSpent);
  animateNumber(remainingEl, Math.max(0, budget - totalSpent));
  animateNumberRaw(budgetValueEl, budget, v => v.toLocaleString("zh-CN"));
  const bar = document.getElementById("budgetProgressBar");
  const overrunTag = document.getElementById("budgetOverrunTag");
  const card = document.getElementById("budgetCard");
  if (!bar) return;
  const pct = budget > 0 ? Math.min((totalSpent / budget) * 100, 100) : 0;
  bar.style.width = pct + "%";
  if (totalSpent >= budget) {
    bar.classList.replace("warn", "over") || bar.classList.add("over");
    overrunTag.classList.remove("hidden"); card?.classList.add("budget-card-over");
  } else if (totalSpent >= budget * 0.8) {
    bar.classList.replace("over", "warn") || bar.classList.add("warn");
    overrunTag.classList.add("hidden"); card?.classList.remove("budget-card-over");
  } else {
    bar.classList.remove("warn", "over");
    overrunTag.classList.add("hidden"); card?.classList.remove("budget-card-over");
  }
}

// ── 环比分析 ──────────────────────────────────────────
function updateMoMBadge(cur, last) {
  lastMonthTotalCached = last ?? lastMonthTotalCached;
  const lmt = lastMonthTotalCached;
  const stripEl = document.getElementById("momInline");
  if (stripEl) {
    if (!lmt) { stripEl.classList.add("hidden"); }
    else {
      const diff = cur - lmt, pct = Math.abs((diff / lmt) * 100).toFixed(1);
      stripEl.classList.remove("hidden");
      if      (diff < 0) { stripEl.textContent = `↓ 比上月省了 ${pct}%`; stripEl.style.color = "#10b981"; }
      else if (diff > 0) { stripEl.textContent = `↑ 比上月多花了 ${pct}%`; stripEl.style.color = "#ef4444"; }
      else               { stripEl.textContent = "与上月持平"; stripEl.style.color = "#94a3b8"; }
    }
  }
  const section = document.getElementById("insightSection");
  if (!section) return;
  const e = {
    badge: document.getElementById("insightBadge"),    delta: document.getElementById("insightDelta"),
    label: document.getElementById("insightDeltaLabel"), cur: document.getElementById("insightCurrent"),
    last:  document.getElementById("insightLast"),     barC: document.getElementById("insightBarCurrent"),
    barL:  document.getElementById("insightBarLast"),  pctC: document.getElementById("insightCurrentPct"),
    pctL:  document.getElementById("insightLastPct"),
  };
  section.classList.remove("hidden");
  e.cur.textContent  = formatMoney(cur);
  e.last.textContent = lmt > 0 ? formatMoney(lmt) : "¥ 0";
  if (!lmt) {
    e.delta.textContent = "-"; e.delta.className = "text-2xl font-bold tracking-tight text-slate-400 tabular-nums";
    e.label.textContent = "首月开始记录"; e.badge.textContent = "首月记录"; e.badge.className = "insight-badge";
    e.barC.style.width = cur > 0 ? "55%" : "0%"; e.barL.style.width = "0%";
    e.pctC.textContent = e.pctL.textContent = "";
    return;
  }
  const diff = cur - lmt, pct = Math.abs((diff / lmt) * 100).toFixed(1), max = Math.max(cur, lmt, 1);
  if (diff < 0) {
    e.delta.textContent = `${pct}%`; e.delta.className = "text-2xl font-bold tracking-tight text-emerald-500 tabular-nums";
    e.label.textContent = "比上月省了 ↓"; e.badge.textContent = "支出减少"; e.badge.className = "insight-badge good";
  } else if (diff > 0) {
    e.delta.textContent = `${pct}%`; e.delta.className = "text-2xl font-bold tracking-tight text-red-500 tabular-nums";
    e.label.textContent = "比上月多花了 ↑"; e.badge.textContent = "支出增加"; e.badge.className = "insight-badge warn";
  } else {
    e.delta.textContent = "0%"; e.delta.className = "text-2xl font-bold tracking-tight text-slate-500 tabular-nums";
    e.label.textContent = "与上月持平"; e.badge.textContent = "持平"; e.badge.className = "insight-badge";
  }
  const cPct = Math.round((cur / max) * 100), lPct = Math.round((lmt / max) * 100);
  setTimeout(() => { e.barC.style.width = cPct + "%"; e.barL.style.width = lPct + "%"; }, 60);
  e.pctC.textContent = cur > 0 ? cPct + "%" : "0%";
  e.pctL.textContent = lmt > 0 ? lPct + "%" : "0%";
}

// ── 成员筛选 ──────────────────────────────────────────
const recordMatchesRecentFilter = r => {
  if (!recentExpenseFilterMember) return true;
  const m = r.member || "";
  return m === recentExpenseFilterMember || (!m && recentExpenseFilterMember === AS.session.member);
};
const gatherMemberNames = () => {
  const names = new Set();
  if (AS.session?.member) names.add(AS.session.member);
  (loadFamiliesData().families?.[AS.session.familyCode]?.members || []).forEach(x => x && names.add(x));
  AS.expenses.forEach(e => { if (e.member) names.add(e.member); });
  return Array.from(names).sort((a, b) => a.localeCompare(b, "zh-CN"));
};
const truncateLabel = s => { const chars = [...String(s || "")]; return chars.length <= 5 ? chars.join("") : chars.slice(0, 5).join("") + "..."; };

function updateRecentConsumeHeading() {
  const el = document.getElementById("recentConsumeHeading");
  if (el) el.textContent = recentExpenseFilterMember ? `${recentExpenseFilterMember}的消费` : "全部消费";
}
function updateRecentFilteredTotalStrip() {
  const capEl = document.getElementById("recentFilteredTotalCaption");
  const amtEl = document.getElementById("recentFilteredTotalAmount");
  if (!amtEl || !capEl) return;
  const total = AS.expenses.reduce((s, e) => recordMatchesRecentFilter(e) ? s + (Number(e.amount) || 0) : s, 0);
  amtEl.textContent = formatMoney(total);
  capEl.textContent = recentExpenseFilterMember
    ? `${recentExpenseFilterMember} · 下列账单本月合计`
    : "下列账单本月合计 · 全部成员";
}
function refreshRecentMemberFilterUI() {
  const sel = document.getElementById("recentMemberFilter");
  if (!sel || !AS.session) return;
  const members = gatherMemberNames();
  sel.innerHTML = `<option value="__all__">全部</option>`;
  members.forEach(nm => {
    const o = document.createElement("option");
    o.value = nm; o.textContent = truncateLabel(nm); sel.appendChild(o);
  });
  if (recentExpenseFilterMember && !members.includes(recentExpenseFilterMember)) recentExpenseFilterMember = null;
  sel.value = recentExpenseFilterMember || "__all__";
  updateRecentConsumeHeading();
  updateRecentFilteredTotalStrip();
}

// ── 排序 ──────────────────────────────────────────────
const expenseMs = r => { const raw = r.timestamp ?? r.created_at ?? null; if (raw == null) return 0; if (typeof raw === "number" && Number.isFinite(raw)) return raw; const ms = new Date(raw).getTime(); return Number.isFinite(ms) ? ms : 0; };
const daySerial = ms => { if (!ms) return 0; const d = new Date(ms); return d.getFullYear() * 1e4 + (d.getMonth()+1) * 100 + d.getDate(); };
const sortForDisplay = list => [...list].sort((a, b) => { const ma = expenseMs(a), mb = expenseMs(b), da = daySerial(ma), db = daySerial(mb); return db !== da ? db-da : mb !== ma ? mb-ma : String(b.id||"").localeCompare(String(a.id||"")); });

// ── 骨架屏 & 空态 ─────────────────────────────────────
const _emptyStateEl = document.getElementById("expenseEmptyState");
function showExpensesSkeleton() {
  expenseList.innerHTML = "";
  _emptyStateEl?.classList.add("hidden");
  for (let i = 0; i < 3; i++) {
    const row = document.createElement("div");
    row.dataset.skeleton = "1";
    row.className = "flex items-center gap-3 px-4 py-3.5 border-b border-slate-100 last:border-0";
    row.innerHTML = `<div class="sk h-9 w-9 shrink-0 rounded-2xl"></div>
      <div class="flex-1 min-w-0 space-y-2">
        <div class="sk h-3.5 rounded" style="width:${55 + i * 13}%"></div>
        <div class="sk h-3 rounded" style="width:${32 + i * 8}%"></div>
      </div><div class="sk h-4 w-14 shrink-0 rounded"></div>`;
    expenseList.appendChild(row);
  }
  updateRecentFilteredTotalStrip();
}
const hideExpensesSkeleton = () => expenseList.querySelectorAll("[data-skeleton]").forEach(n => n.remove());
function syncEmptyState(count) {
  if (!_emptyStateEl) return;
  _emptyStateEl.classList.toggle("hidden", count > 0);
  _emptyStateEl.classList.toggle("flex",   count === 0);
}

// ── 行创建 ────────────────────────────────────────────
function createExpenseRow(record, { enableSwipeDelete = false } = {}) {
  const article = document.createElement("article");
  article.className = "relative overflow-hidden";
  article.dataset.recordId = record.id;
  article.dataset.dynamic  = "1";

  const d = new Date(record.timestamp ?? record.created_at);
  const time    = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const isToday = getDateKey(d) === getDateKey(new Date());
  const config  = categoryConfig[record.category] || categoryConfig["其他"];

  article.innerHTML = `
    <div class="swipe-delete-bg pointer-events-none absolute inset-0 hidden items-center justify-end bg-red-50/80 pr-4">
      <div class="swipe-delete-icon flex h-8 w-8 items-center justify-center rounded-full bg-red-100 text-red-500"
           style="opacity:0;transform:translateX(16px);transition:opacity 0.2s cubic-bezier(0.22,1,0.36,1),transform 0.2s cubic-bezier(0.22,1,0.36,1);">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 10v6M14 10v6"/>
        </svg>
      </div>
    </div>
    <div class="row-content flex items-center px-4 py-3.5 sm:px-5 bg-white transition-transform duration-150">
      <span class="mr-3 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-xl" style="background:${config.chartColor}18">${config.emoji}</span>
      <div class="flex-1 min-w-0">
        <p class="truncate text-[15px] font-medium text-slate-900 name-el"></p>
        <div class="mt-0.5 flex flex-col text-xs text-slate-400">
          <div class="flex items-center gap-1.5">
            <span>${isToday ? "今天" : `${d.getMonth() + 1}月${d.getDate()}日`} · ${time} · ${record.category}</span>
            ${record.member ? `<span class="rounded-full bg-slate-100 px-1.5 py-px text-[10px] text-slate-500">来自 ${record.member}</span>` : ""}
          </div>
          ${record.note ? `<span class="italic mt-0.5 note-el"></span>` : ""}
        </div>
      </div>
      <p class="shrink-0 mx-3 text-lg font-semibold text-slate-900 amount-el"></p>
      <button type="button" class="delete-record-btn inline-flex h-9 w-9 items-center justify-center rounded-full text-slate-400 transition hover:bg-red-50 hover:text-red-500" title="删除账单" aria-label="删除账单">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 10v6M14 10v6"/>
        </svg>
      </button>
    </div>`;

  article.querySelector(".name-el").textContent   = record.name;
  article.querySelector(".amount-el").textContent = `- ${formatMoney(Number(record.amount))}`;
  const noteEl = article.querySelector(".note-el");
  if (noteEl && record.note) noteEl.textContent = record.note;

  if (enableSwipeDelete) {
    const rowContentEl = article.querySelector(".row-content");
    const swipeBgEl    = article.querySelector(".swipe-delete-bg");
    const swipeIconEl  = article.querySelector(".swipe-delete-icon");
    let startX = 0, startY = 0, swiping = false, triggered = false;
    rowContentEl.style.transition = "transform 0.18s cubic-bezier(0.22,1,0.36,1)";
    swipeBgEl.classList.replace("hidden", "flex") || swipeBgEl.classList.add("flex");

    article.addEventListener("touchstart", e => {
      if (deletingExpenseIds.has(record.id)) return;
      startX = e.touches[0].clientX; startY = e.touches[0].clientY;
      swiping = true; triggered = false;
    }, { passive: true });
    article.addEventListener("touchmove", e => {
      if (!swiping || triggered) return;
      const dx = e.touches[0].clientX - startX, dy = e.touches[0].clientY - startY;
      if (Math.abs(dx) <= Math.abs(dy)) return;
      if (dx < 0) {
        const shift = Math.max(dx, -SWIPE_MAX);
        rowContentEl.style.transform = `translateX(${shift}px)`;
        const prog = Math.min(1, Math.abs(shift) / SWIPE_TRIGGER);
        swipeIconEl.style.opacity   = String(prog);
        swipeIconEl.style.transform = `translateX(${Math.max(0, 16 + shift * 0.25)}px)`;
      }
    }, { passive: true });
    article.addEventListener("touchend", async () => {
      if (!swiping || triggered) return;
      swiping = false;
      const currentX = (new DOMMatrixReadOnly(getComputedStyle(rowContentEl).transform)).m41 || 0;
      rowContentEl.style.transition = "transform 0.28s cubic-bezier(0.22, 1, 0.36, 1)";
      rowContentEl.style.transform  = "translateX(0px)";
      swipeIconEl.style.opacity = "0"; swipeIconEl.style.transform = "translateX(16px)";
      if (currentX <= -SWIPE_TRIGGER) { triggered = true; await handleDeleteRecord(record.id); }
    });
  }
  return article;
}

// ── 删除按钮事件委托 ──────────────────────────────────
function bindListDelegation(list) {
  if (!list) return;
  list.addEventListener("pointerdown", e => {
    const btn = e.target.closest(".delete-record-btn");
    if (btn) { btn.classList.remove("btn-pressed"); void btn.offsetWidth; btn.classList.add("btn-pressed"); }
  });
  list.addEventListener("animationend", e => {
    if (e.target.classList.contains("delete-record-btn")) e.target.classList.remove("btn-pressed");
  }, true);
  list.addEventListener("click", async e => {
    const btn = e.target.closest(".delete-record-btn");
    if (!btn) return;
    e.preventDefault(); e.stopPropagation();
    const id = btn.closest("[data-record-id]")?.dataset.recordId;
    if (id) await handleDeleteRecord(id, { sourceButton: btn });
  });
}
bindListDelegation(expenseList);

// ── 渲染 & 汇总 ───────────────────────────────────────
const renderExpenses = () => {
  hideExpensesSkeleton();
  const sorted = sortForDisplay(AS.expenses.filter(recordMatchesRecentFilter));
  expenseList.replaceChildren(...sorted.map(r => createExpenseRow(r)));
  syncEmptyState(sorted.length);
  updateRecentFilteredTotalStrip();
};
const refreshView = () => { renderExpenses(); recalculateTotal(); };
function recalculateTotal() {
  const n = new Date(), y = n.getFullYear(), m = n.getMonth();
  totalSpent = AS.expenses
    .filter(e => { const d = new Date(e.timestamp); return d.getFullYear() === y && d.getMonth() === m; })
    .reduce((sum, item) => sum + Number(item.amount), 0);
  updateSummary(); updateChart(); updateMonthlyRanking(); updateWeeklyChart();
  updateMoMBadge(totalSpent, lastMonthTotalCached);
  updateRecentFilteredTotalStrip();
}

// ── 删除逻辑 ──────────────────────────────────────────
async function handleDeleteRecord(id, { sourceButton } = {}) {
  if (!id) { showToast("删除失败：账单缺少 id"); return; }
  if (deletingExpenseIds.has(id)) { showToast("正在删除中，请稍候…"); return; }
  if (!confirm("确定要删除这笔账吗？")) return;

  deletingExpenseIds.add(id);
  if (sourceButton) { sourceButton.disabled = true; sourceButton.classList.add("opacity-40", "cursor-not-allowed"); }

  const snapshot = [...AS.expenses];
  AS.expenses = AS.expenses.filter(e => e.id !== id);
  saveExpenseCache(AS.session.familyCode, AS.expenses);
  refreshView();
  if (historyLoaded) await loadHistoryMonth(historyDate.year, historyDate.month);

  try {
    if (!await deleteExpenseFromCloud(id)) {
      AS.expenses = snapshot; saveExpenseCache(AS.session.familyCode, snapshot);
      refreshView();
      if (historyLoaded) await loadHistoryMonth(historyDate.year, historyDate.month);
      showToast("删除失败，已恢复这笔账单。请检查网络后重试");
    } else {
      const fresh = await fetchFamilyExpenses();
      AS.expenses = fresh; saveExpenseCache(AS.session.familyCode, fresh); clearHistoryCache(AS.session.familyCode);
      refreshView();
      if (historyLoaded) await loadHistoryMonth(historyDate.year, historyDate.month);
      showToast("已删除账单 ✓");
    }
  } catch {
    AS.expenses = snapshot; saveExpenseCache(AS.session.familyCode, snapshot);
    refreshView();
    if (historyLoaded) await loadHistoryMonth(historyDate.year, historyDate.month);
    showToast("删除异常，已恢复这笔账单。请稍后重试");
  } finally {
    deletingExpenseIds.delete(id);
    if (sourceButton) { sourceButton.disabled = false; sourceButton.classList.remove("opacity-40", "cursor-not-allowed"); }
  }
}

// ── Modal ─────────────────────────────────────────────
let _modalSavedScrollY = 0, _vvCleanup = null;

function openModal() {
  if (!modal.classList.contains("hidden")) return;
  overlay.classList.remove("hidden");
  modal.classList.remove("hidden");
  dateInput.value = dateInput.max = getDateKey(new Date());
  _modalSavedScrollY = window.scrollY || 0;
  document.body.style.top = `${-_modalSavedScrollY}px`;
  document.documentElement.classList.add("modal-sheet-open");
  document.body.classList.add("modal-sheet-open");
  const vv = window.visualViewport;
  const sync = () => {
    const narrow  = window.matchMedia("(max-width: 639px)").matches;
    const overlap = vv ? Math.max(0, window.innerHeight - vv.offsetTop - vv.height) : 0;
    modal.style.setProperty("--keyboard-overlap", overlap ? `${overlap}px` : "0px");
    if (vv && narrow) { modal.style.setProperty("--vv-left", `${vv.offsetLeft}px`); modal.style.setProperty("--vv-width", `${vv.width}px`); }
    else { modal.style.removeProperty("--vv-left"); modal.style.removeProperty("--vv-width"); }
  };
  sync();
  if (vv) { vv.addEventListener("resize", sync); vv.addEventListener("scroll", sync); }
  window.addEventListener("resize", sync); window.addEventListener("orientationchange", sync);
  _vvCleanup = () => {
    if (vv) { vv.removeEventListener("resize", sync); vv.removeEventListener("scroll", sync); }
    window.removeEventListener("resize", sync); window.removeEventListener("orientationchange", sync);
    ["--keyboard-overlap","--vv-left","--vv-width"].forEach(p => modal.style.removeProperty(p));
  };
  setTimeout(() => nameInput.focus(), 0);
}
function closeModal() {
  if (modal.classList.contains("hidden")) return;
  if (_vvCleanup) { _vvCleanup(); _vvCleanup = null; }
  document.documentElement.classList.remove("modal-sheet-open");
  document.body.classList.remove("modal-sheet-open");
  document.body.style.top = "";
  window.scrollTo(0, _modalSavedScrollY);
  _modalSavedScrollY = 0;
  overlay.classList.add("hidden");
  modal.classList.add("hidden");
  form.reset();
  dateInput.value = dateInput.max = getDateKey(new Date());
}

// ── Realtime ──────────────────────────────────────────
function subscribeRealtime() {
  if (realtimeChannel) { sb.removeChannel(realtimeChannel); realtimeChannel = null; }
  realtimeChannel = sb
    .channel(`family-${AS.session.familyCode}`)
    .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "expenses", filter: `family_code=eq.${AS.session.familyCode}` },
      payload => {
        const row = payload.new;
        if (AS.expenses.some(e => e.id === row.id)) return;
        const rn = new Date(), rd = new Date(row.created_at);
        if (rd.getFullYear() !== rn.getFullYear() || rd.getMonth() !== rn.getMonth()) return;
        const record = { id: row.id, name: row.name, amount: row.amount, category: row.category,
          note: row.note, member: row.member, timestamp: row.created_at, created_at: row.created_at };
        AS.expenses.unshift(record);
        saveExpenseCache(AS.session.familyCode, AS.expenses);
        renderExpenses();
        expenseList.querySelector(`[data-record-id="${record.id}"]`)?.classList.add("sync-flash");
        recalculateTotal();
      })
    .on("postgres_changes",
      { event: "DELETE", schema: "public", table: "expenses", filter: `family_code=eq.${AS.session.familyCode}` },
      payload => {
        const id = payload.old?.id;
        if (!id) return;
        AS.expenses = AS.expenses.filter(e => e.id !== id);
        saveExpenseCache(AS.session.familyCode, AS.expenses);
        refreshView();
        if (historyLoaded) loadHistoryMonth(historyDate.year, historyDate.month);
      })
    .subscribe(status => { syncDot.classList.toggle("hidden", status !== "SUBSCRIBED"); });
}
const unsubscribeRealtime = () => {
  if (realtimeChannel) { sb.removeChannel(realtimeChannel); realtimeChannel = null; }
  syncDot.classList.add("hidden");
};

// ── 启动遮罩 ──────────────────────────────────────────
function dismissSplashScreen() {
  const el = document.getElementById("splash-screen");
  if (!el || el.dataset.done === "1") return;
  el.dataset.done = "1";
  const wait = Math.max(0, 720 - (performance.now() - _splashShownAt));
  setTimeout(() => { el.classList.add("fade-out"); setTimeout(() => { el.style.display = "none"; el.remove(); }, 800); }, wait);
}

// ── initApp ───────────────────────────────────────────
async function initApp() {
  loginOverlay.classList.add("hidden");
  memberLabel.textContent = `🏠 ${AS.session.familyCode}  ·  ${AS.session.member}`;

  recentExpenseFilterMember = localStorage.getItem(RECENT_FILTER_KEY) ? AS.session.member : null;
  localStorage.removeItem("wallet_expense_cache_v1");

  let orphans = [];
  const raw = localStorage.getItem("wallet_added_expenses_v2");
  if (raw) orphans = JSON.parse(raw);
  const toUpload = orphans.filter(r => !r.family_code);
  if (toUpload.length) {
    await Promise.all(toUpload.map(r => sb.from("expenses").upsert({
      id: r.id, family_code: AS.session.familyCode, member: AS.session.member,
      name: r.name, amount: r.amount, category: r.category || "其他",
      note: r.note || null, created_at: r.timestamp || new Date().toISOString(),
    })));
    localStorage.removeItem("wallet_added_expenses_v2");
  }

  const cached = loadExpenseCache(AS.session.familyCode);
  if (cached.length > 0) { AS.expenses = cached; refreshRecentMemberFilterUI(); refreshView(); }
  else { refreshRecentMemberFilterUI(); showExpensesSkeleton(); }

  registerAllLocalFamilies();
  syncFamilyMembers(() => refreshRecentMemberFilterUI());
  await flushPendingUploads();

  const [cloudBudget, lastMonthTotal, fresh] = await Promise.all([
    fetchFamilyBudget(), fetchLastMonthTotal(), fetchFamilyExpenses(),
  ]);
  if (cloudBudget && cloudBudget !== budget) { budget = cloudBudget; localStorage.setItem(BUDGET_KEY, String(budget)); }

  const freshSig  = fresh.map(e => e.id).join(",");
  const cachedSig = cached.map(e => e.id).join(",");
  AS.expenses = fresh;
  saveExpenseCache(AS.session.familyCode, fresh);
  refreshRecentMemberFilterUI(); refreshView();
  updateMoMBadge(totalSpent, lastMonthTotal);
  if (cached.length > 0 && freshSig !== cachedSig) showToast("已同步最新账单 ✓");

  subscribeRealtime();
  if (!localStorage.getItem(RECENT_FILTER_KEY)) localStorage.setItem(RECENT_FILTER_KEY, "1");

  let _lastKnownYM = currentYM();
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;
    const nowYM = currentYM();
    if (nowYM === _lastKnownYM) return;
    _lastKnownYM = nowYM;
    AS.expenses = [];
    refreshRecentMemberFilterUI(); refreshView();
    showToast(`已切换到 ${nowYM.replace("-", "月").replace(/^\d{4}/, "")}月账单`);
    const [cb, lmt, fr] = await Promise.all([fetchFamilyBudget(), fetchLastMonthTotal(), fetchFamilyExpenses()]);
    if (cb && cb !== budget) { budget = cb; localStorage.setItem(BUDGET_KEY, String(budget)); }
    AS.expenses = fr; saveExpenseCache(AS.session.familyCode, fr);
    refreshRecentMemberFilterUI(); refreshView(); updateMoMBadge(totalSpent, lmt);
  });

  dismissSplashScreen();
}

// ── 预算弹窗 ──────────────────────────────────────────
const openBudgetModal  = () => { budgetInput.value = budget; budgetOverlay.classList.remove("hidden"); budgetOverlay.classList.add("flex"); requestAnimationFrame(() => budgetInput.focus()); };
const closeBudgetModal = () => { budgetOverlay.classList.add("hidden"); budgetOverlay.classList.remove("flex"); };

budgetDisplay.addEventListener("click", openBudgetModal);
cancelBudgetBtn.addEventListener("click", closeBudgetModal);
budgetOverlay.addEventListener("click", e => { if (e.target === budgetOverlay) closeBudgetModal(); });
document.querySelectorAll(".budget-preset").forEach(btn =>
  btn.addEventListener("click", () => { budgetInput.value = btn.dataset.val; budgetInput.focus(); })
);
saveBudgetBtn.addEventListener("click", () => {
  const v = Number(budgetInput.value);
  if (!v || v <= 0 || saveBudgetBtn.disabled) { budgetInput.focus(); return; }
  saveBudgetBtn.disabled = true;
  setTimeout(() => { saveBudgetBtn.disabled = false; }, 600);
  budget = v; localStorage.setItem(BUDGET_KEY, String(v));
  updateSummary(); closeBudgetModal(); saveFamilyBudgetToCloud(v);
});
budgetInput.addEventListener("keydown", e => { if (e.key === "Enter") saveBudgetBtn.click(); if (e.key === "Escape") closeBudgetModal(); });

// ── 登录 UI ───────────────────────────────────────────
const familySelectWrap = document.getElementById("familySelectWrap");
const familySelectBtn  = document.getElementById("familySelectBtn");
const familySelectText = document.getElementById("familySelectText");
const familyNewInput   = document.getElementById("familyNewInput");
const familyDropdown   = document.getElementById("familyDropdown");
const memberSelectWrap = document.getElementById("memberSelectWrap");
const memberSelectBtn  = document.getElementById("memberSelectBtn");
const memberSelectText = document.getElementById("memberSelectText");
const memberNewInput   = document.getElementById("memberNewInput");
const memberDropdown   = document.getElementById("memberDropdown");
const memberHint       = document.getElementById("memberHint");

let familiesData = {}, currentFamily = "", currentMember = "";
let familyMode = "dropdown", memberMode = "dropdown";

const openFamilyDropdown  = () => { closeMemberDropdown(); renderLoginDropdown("family"); familyDropdown.classList.remove("hidden"); familySelectBtn.classList.add("open"); };
const closeFamilyDropdown = () => { familyDropdown.classList.add("hidden"); familySelectBtn.classList.remove("open"); };
const openMemberDropdown  = () => { closeFamilyDropdown(); renderLoginDropdown("member"); memberDropdown.classList.remove("hidden"); memberSelectBtn.classList.add("open"); };
const closeMemberDropdown = () => { memberDropdown.classList.add("hidden"); memberSelectBtn.classList.remove("open"); };

function switchFamilyMode(mode) {
  familyMode = mode;
  familySelectBtn.classList.toggle("hidden", mode !== "dropdown");
  familyNewInput.classList.toggle("hidden",  mode === "dropdown");
  if (mode !== "dropdown") { familyDropdown.classList.add("hidden"); setTimeout(() => familyNewInput.focus(), 0); }
}
function switchMemberMode(mode, autoFocus = false) {
  memberMode = mode;
  memberSelectBtn.classList.toggle("hidden", mode !== "dropdown");
  memberNewInput.classList.toggle("hidden",  mode === "dropdown");
  if (mode !== "dropdown") { memberDropdown.classList.add("hidden"); if (autoFocus) setTimeout(() => memberNewInput.focus(), 0); }
}

function renderLoginDropdown(type) {
  const isFamily = type === "family";
  const dropdown = isFamily ? familyDropdown : memberDropdown;
  const items    = isFamily ? Object.keys(familiesData.families || {}) : ((familiesData.families[currentFamily] || {}).members || []);
  const current  = isFamily ? currentFamily : currentMember;
  const closeDD  = isFamily ? closeFamilyDropdown : closeMemberDropdown;
  const onSelect = isFamily ? selectFamily : selectMember;
  const addLabel = isFamily ? "新建家庭" : "新增昵称";
  const onAdd    = isFamily
    ? () => { closeFamilyDropdown(); switchFamilyMode("text"); switchMemberMode("text"); familyNewInput.value = ""; memberNewInput.value = ""; currentFamily = ""; currentMember = ""; }
    : () => { closeMemberDropdown(); switchMemberMode("text", true); currentMember = ""; memberNewInput.value = ""; };

  dropdown.innerHTML = "";
  items.forEach(name => {
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "custom-dropdown-option" + (name === current ? " selected" : "");
    btn.textContent = name;
    btn.addEventListener("click", () => { onSelect(name); closeDD(); });
    dropdown.appendChild(btn);
  });
  const addBtn = document.createElement("button");
  addBtn.type = "button"; addBtn.className = "custom-dropdown-add";
  addBtn.innerHTML = `<svg class="h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>${addLabel}`;
  addBtn.addEventListener("click", onAdd);
  dropdown.appendChild(addBtn);
}

function selectFamily(name) {
  currentFamily = name; currentMember = "";
  familySelectText.className = "custom-select-value"; familySelectText.textContent = name;
  const fam = familiesData.families[name] || {};
  if ((fam.members || []).length > 0) {
    switchMemberMode("dropdown");
    const last = fam.lastMember;
    if (last && fam.members.includes(last)) selectMember(last);
    else { memberSelectText.className = "custom-select-placeholder"; memberSelectText.textContent = "请选择昵称"; }
  } else { switchMemberMode("text"); memberNewInput.value = ""; }
}
const selectMember = name => {
  currentMember = name;
  memberSelectText.className = "custom-select-value"; memberSelectText.textContent = name;
};

familySelectBtn.addEventListener("click", e => { e.stopPropagation(); familyDropdown.classList.contains("hidden") ? openFamilyDropdown() : closeFamilyDropdown(); });
memberSelectBtn.addEventListener("click", e => { e.stopPropagation(); memberDropdown.classList.contains("hidden") ? openMemberDropdown() : closeMemberDropdown(); });
document.addEventListener("click", e => {
  if (familySelectWrap && !familySelectWrap.contains(e.target)) closeFamilyDropdown();
  if (memberSelectWrap && !memberSelectWrap.contains(e.target)) closeMemberDropdown();
});

const setMemberHint = (state, text) => {
  memberHint.className = "member-hint " + state;
  memberHint.textContent = text;
  memberHint.classList.toggle("hidden", !text || state === "hidden");
};

let _memberLookupTimer = null;
familyNewInput.addEventListener("input", () => {
  const typed = familyNewInput.value.trim();
  clearTimeout(_memberLookupTimer);
  if (typed && familiesData.families[typed]) { setMemberHint("found", "✓ 已找到家庭"); selectFamily(typed); return; }
  currentFamily = ""; currentMember = "";
  switchMemberMode("text"); memberNewInput.value = "";
  setMemberHint("hidden", "");
  if (!typed) return;
  setMemberHint("loading", "联网查询中…");
  _memberLookupTimer = setTimeout(async () => {
    if (familyNewInput.value.trim() !== typed) return;
    let cloudMembers = [];
    const { data: fd } = await sb.from("families").select("member").eq("family_code", typed);
    if (fd?.length) {
      cloudMembers = [...new Set(fd.map(r => r.member).filter(Boolean))];
    } else {
      const { data: ed } = await sb.from("expenses").select("member").eq("family_code", typed).limit(500);
      if (ed?.length) {
        const freq = {};
        ed.forEach(r => { if (r.member) freq[r.member] = (freq[r.member] || 0) + 1; });
        cloudMembers = Object.entries(freq).sort((a, b) => b[1] - a[1]).map(([m]) => m);
      }
    }
    if (!cloudMembers.length) { setMemberHint("notfound", "未找到此家庭，将新建"); return; }
    if (!familiesData.families[typed]) familiesData.families[typed] = { lastMember: cloudMembers[0], members: [] };
    cloudMembers.forEach(m => { if (!familiesData.families[typed].members.includes(m)) familiesData.families[typed].members.push(m); });
    familiesData.lastFamily = typed;
    saveFamiliesData(familiesData);
    currentFamily = typed;
    switchMemberMode("dropdown");
    const last = familiesData.families[typed].lastMember;
    if (last && familiesData.families[typed].members.includes(last)) selectMember(last);
    else { currentMember = ""; memberSelectText.className = "custom-select-placeholder"; memberSelectText.textContent = "请选择昵称"; }
    setMemberHint("found", `✓ 找到 ${cloudMembers.length} 位成员`);
  }, 600);
});

async function syncAllFamiliesFromCloud() {
  const hint = document.getElementById("loginSyncStatus");
  const setHint = (cls, txt) => { if (!hint) return; hint.className = `login-sync-status ${cls}`; hint.textContent = txt; };
  setHint("loading", "正在从云端同步家庭列表…");
  const { data: fd } = await sb.from("families").select("family_code, member");
  const rows = fd?.length ? fd : (await sb.from("expenses").select("family_code, member")).data;
  if (!rows?.length) { setHint("notfound", "云端暂无家庭数据，请直接输入"); return; }

  let changed = false;
  rows.forEach(({ family_code, member }) => {
    if (!family_code || !member) return;
    if (!familiesData.families[family_code]) { familiesData.families[family_code] = { lastMember: member, members: [] }; changed = true; }
    const fam = familiesData.families[family_code];
    if (!fam.members.includes(member)) { fam.members.push(member); changed = true; }
  });
  if (changed) saveFamiliesData(familiesData);

  const names = Object.keys(familiesData.families);
  setHint("found", `✓ 已同步 ${names.length} 个家庭`);
  setTimeout(() => setHint("hidden", ""), 3000);
  if (familyMode === "text" && !familyNewInput.value.trim() && names.length) {
    switchFamilyMode("dropdown");
    const lastFam = familiesData.lastFamily && familiesData.families[familiesData.lastFamily] ? familiesData.lastFamily : names[0];
    selectFamily(lastFam);
  } else if (familyMode === "dropdown") { renderLoginDropdown("family"); }
}

function initLoginUI() {
  familiesData = loadFamiliesData();
  const names  = Object.keys(familiesData.families || {});
  if (!names.length) { switchFamilyMode("text"); switchMemberMode("text"); familyNewInput.value = ""; memberNewInput.value = ""; }
  else {
    switchFamilyMode("dropdown");
    const lastFam = familiesData.lastFamily && familiesData.families[familiesData.lastFamily] ? familiesData.lastFamily : names[0];
    selectFamily(lastFam);
  }
  loginError.classList.add("hidden");
  syncAllFamiliesFromCloud();
}

loginForm.addEventListener("submit", async e => {
  e.preventDefault();
  const familyName = familyMode === "text" ? familyNewInput.value.trim() : currentFamily;
  const memberName = memberMode === "text" ? memberNewInput.value.trim() : currentMember;
  if (!familyName || !memberName) { loginError.classList.remove("hidden"); return; }
  loginError.classList.add("hidden");
  if (!familiesData.families[familyName]) {
    familiesData.families[familyName] = { lastMember: memberName, members: [memberName] };
  } else {
    const fam = familiesData.families[familyName];
    if (!fam.members.includes(memberName)) fam.members.push(memberName);
    fam.lastMember = memberName;
  }
  familiesData.lastFamily = familyName;
  saveFamiliesData(familiesData);
  sb.from("families").upsert({ family_code: familyName, member: memberName, updated_at: new Date().toISOString() }, { onConflict: "family_code,member" });
  saveSession({ familyCode: familyName, member: memberName });
  await initApp();
});
logoutBtn.addEventListener("click", () => { unsubscribeRealtime(); clearSession(); location.reload(); });

// ── FAB & 主表单 ──────────────────────────────────────
fabButton.addEventListener("click", openModal);
closeModalBtn.addEventListener("click", closeModal);
overlay.addEventListener("click", closeModal);
document.addEventListener("keydown", e => { if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal(); });

document.getElementById("recentMemberFilter")?.addEventListener("change", e => {
  recentExpenseFilterMember = e.target.value === "__all__" ? null : e.target.value;
  updateRecentConsumeHeading(); renderExpenses();
});

form.addEventListener("submit", async e => {
  e.preventDefault();
  const name     = nameInput.value.trim();
  const amount   = Number(amountInput.value);
  const category = form.querySelector('input[name="category"]:checked').value;
  const note     = noteInput.value.trim();
  if (!name || !Number.isFinite(amount) || amount <= 0) return;
  if (amount > 999 && !confirm(`⚠️ 金额较大：¥${amount.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}\n\n确认金额无误吗？`)) return;

  const ts = buildTimestampFromDateInput(dateInput?.value || "");
  const record = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name, amount, category, note, member: AS.session.member, timestamp: ts, created_at: ts,
  };
  const rd = new Date(record.timestamp), now2 = new Date();
  if (rd.getFullYear() === now2.getFullYear() && rd.getMonth() === now2.getMonth()) {
    AS.expenses.unshift(record);
    saveExpenseCache(AS.session.familyCode, AS.expenses);
    refreshView();
  } else {
    clearHistoryCache(AS.session.familyCode);
    showToast(`补账成功，已记录到 ${rd.getMonth() + 1}月${rd.getDate()}日 ✓`);
  }
  closeModal();
  await saveExpenseToCloud(record);
});

// ── 历史账单视图 ──────────────────────────────────────
const H = {
  view:         document.getElementById("historyView"),
  loading:      document.getElementById("historyLoading"),
  summaryCard:  document.getElementById("historySummaryCard"),
  totalAmount:  document.getElementById("historyTotalAmount"),
  countEl:      document.getElementById("historyCountEl"),
  membersEl:    document.getElementById("historyMembersEl"),
  categoryBars: document.getElementById("historyCategoryBars"),
  expenseList:  document.getElementById("historyExpenseList"),
  empty:        document.getElementById("historyEmpty"),
  searchInput:  document.getElementById("historySearchInput"),
  catChips:     document.getElementById("historyCatChips"),
  filterCount:  document.getElementById("historyFilterCount"),
  searchEmpty:  document.getElementById("historySearchEmpty"),
  monthTitle:   document.getElementById("historyMonthTitle"),
};
bindListDelegation(H.expenseList);

const tabCurrentBtn    = document.getElementById("tabCurrentBtn");
const tabHistoryBtn    = document.getElementById("tabHistoryBtn");
const currentView      = document.getElementById("currentView");
const prevMonthBtn     = document.getElementById("prevMonthBtn");
const nextMonthBtn     = document.getElementById("nextMonthBtn");
const jumpToCurrentBtn = document.getElementById("jumpToCurrentBtn");

let _historyExpenses = [], _historyFilter = { keyword: "", category: "" };
const _now   = new Date();
const NOW_YM = { year: _now.getFullYear(), month: _now.getMonth() + 1 };
const MIN_YM = (() => { const d = new Date(_now.getFullYear() - 5, _now.getMonth(), 1); return { year: d.getFullYear(), month: d.getMonth() + 1 }; })();
let historyDate = { ...NOW_YM }, historyLoaded = false, _historyInflight = null;
const cmpYM = (a, b) => (a.year * 12 + a.month) - (b.year * 12 + b.month);

function applyHistoryFilter() {
  const kw  = _historyFilter.keyword.trim().toLowerCase();
  const cat = _historyFilter.category;
  const result = _historyExpenses.filter(e => {
    const matchCat = !cat || e.category === cat;
    const matchKw  = !kw || ["name","note","member"].some(k => (e[k] || "").toLowerCase().includes(kw));
    return matchCat && matchKw;
  });
  H.expenseList.innerHTML = "";
  if (_historyExpenses.length && !result.length) {
    H.expenseList.classList.add("hidden");
    H.searchEmpty.classList.remove("hidden"); H.searchEmpty.classList.add("flex");
  } else {
    H.expenseList.classList.remove("hidden");
    H.searchEmpty.classList.add("hidden"); H.searchEmpty.classList.remove("flex");
    sortForDisplay(result).forEach(r => H.expenseList.appendChild(createExpenseRow(r, { enableSwipeDelete: true })));
  }
  const isFiltering = !!(kw || cat);
  if (isFiltering && _historyExpenses.length) {
    H.filterCount.textContent = `找到 ${result.length} / ${_historyExpenses.length} 笔`;
    H.filterCount.classList.remove("hidden");
  } else { H.filterCount.classList.add("hidden"); }
}

function buildCatChips(expenses) {
  H.catChips.innerHTML = "";
  const catCount = {};
  expenses.forEach(e => { if (e.category) catCount[e.category] = (catCount[e.category] || 0) + 1; });
  ["全部", ...Object.keys(catCount).sort((a, b) => catCount[b] - catCount[a])].forEach(cat => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "cat-chip" + (cat === "全部" ? " active" : "");
    chip.textContent = cat !== "全部" ? `${categoryConfig[cat]?.emoji ?? ""} ${cat}`.trim() : "全部";
    chip.addEventListener("click", () => {
      _historyFilter.category = cat === "全部" ? "" : cat;
      H.catChips.querySelectorAll(".cat-chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active"); applyHistoryFilter();
    });
    H.catChips.appendChild(chip);
  });
}

let _searchDebounceTimer = null;
H.searchInput.addEventListener("input", () => {
  clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(() => { _historyFilter.keyword = H.searchInput.value; applyHistoryFilter(); }, 280);
});
H.searchInput.addEventListener("search", () => { _historyFilter.keyword = H.searchInput.value; applyHistoryFilter(); });

async function fetchMonthExpenses(year, month) {
  const { data, error } = await sb.from("expenses").select("*")
    .eq("family_code", AS.session.familyCode)
    .gte("created_at", new Date(year, month - 1, 1).toISOString())
    .lt("created_at",  new Date(year, month,     1).toISOString())
    .order("created_at", { ascending: false });
  if (error) return [];
  return (data || []).map(r => ({
    id: r.id, name: r.name, amount: r.amount, category: r.category,
    note: r.note, member: r.member, timestamp: r.created_at, created_at: r.created_at,
  }));
}

function renderHistoryMonth(year, month, expenses) {
  H.monthTitle.textContent = `${year}年${month}月`;
  prevMonthBtn.disabled    = cmpYM({ year, month }, MIN_YM) <= 0;
  nextMonthBtn.disabled    = cmpYM({ year, month }, NOW_YM) >= 0;

  const total = expenses.reduce((s, e) => s + Number(e.amount), 0);
  H.totalAmount.textContent = formatMoney(total);
  H.countEl.textContent     = `共 ${expenses.length} 笔`;

  const mem = {};
  expenses.forEach(e => { if (e.member) mem[e.member] = (mem[e.member] || 0) + 1; });
  H.membersEl.textContent = Object.entries(mem).map(([m, c]) => `${m} ${c}笔`).join(" · ");

  const catTotals = {}, catColors = Object.fromEntries(Object.entries(categoryConfig).map(([k, v]) => [k, v.chartColor]));
  expenses.forEach(e => { catTotals[e.category] = (catTotals[e.category] || 0) + Number(e.amount); });
  H.categoryBars.innerHTML = "";
  Object.entries(catTotals).sort((a, b) => b[1] - a[1]).forEach(([cat, amt]) => {
    const pct = total > 0 ? +((amt / total) * 100).toFixed(1) : 0;
    const color = catColors[cat] || "#8e8e93";
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <div class="mb-1.5 flex items-center justify-between text-xs">
        <span class="flex items-center gap-1.5 font-medium text-slate-700">
          <span class="inline-block h-2 w-2 rounded-full" style="background:${color}"></span>${cat}
        </span>
        <span class="text-slate-500">${formatMoney(amt)}<span class="ml-1.5 text-slate-300">${pct}%</span></span>
      </div>
      <div class="cat-bar-track"><div class="cat-bar-fill" style="background:${color}"></div></div>`;
    H.categoryBars.appendChild(wrap);
    requestAnimationFrame(() => { wrap.querySelector(".cat-bar-fill").style.width = `${pct}%`; });
  });

  _historyExpenses = expenses;
  _historyFilter   = { keyword: "", category: "" };
  H.searchInput.value = "";
  buildCatChips(expenses);
  H.filterCount.classList.add("hidden");
  H.searchEmpty.classList.add("hidden"); H.searchEmpty.classList.remove("flex");

  if (!expenses.length) {
    H.empty.classList.remove("hidden"); H.empty.classList.add("flex");
    H.expenseList.classList.add("hidden");
  } else {
    H.empty.classList.add("hidden"); H.empty.classList.remove("flex");
    H.expenseList.classList.remove("hidden");
    applyHistoryFilter();
  }
}

async function loadHistoryMonth(year, month) {
  const key = `${year}-${month}`;
  const hit = loadHistoryCache(AS.session.familyCode, year, month);
  if (hit) { _historyInflight = null; renderHistoryMonth(year, month, hit); return; }
  _historyInflight = key;
  H.loading.classList.remove("hidden"); H.loading.classList.add("flex");
  H.summaryCard.style.opacity = "0.45";
  const expenses = await fetchMonthExpenses(year, month);
  if (_historyInflight !== key) return;
  _historyInflight = null;
  saveHistoryCache(AS.session.familyCode, year, month, expenses);
  H.loading.classList.add("hidden"); H.loading.classList.remove("flex");
  H.summaryCard.style.opacity = "";
  renderHistoryMonth(year, month, expenses);
}

const switchToHistory = () => {
  tabHistoryBtn.classList.add("active"); tabCurrentBtn.classList.remove("active");
  H.view.classList.remove("hidden"); H.view.classList.add("flex");
  currentView.classList.add("hidden"); currentView.classList.remove("flex");
  fabButton.classList.add("hidden");
  requestAnimationFrame(() => updateWeeklyChart());
  if (!historyLoaded) { historyLoaded = true; loadHistoryMonth(historyDate.year, historyDate.month); }
};
tabCurrentBtn.addEventListener("click", () => {
  tabCurrentBtn.classList.add("active"); tabHistoryBtn.classList.remove("active");
  currentView.classList.remove("hidden"); currentView.classList.add("flex");
  H.view.classList.add("hidden"); H.view.classList.remove("flex");
  fabButton.classList.remove("hidden");
  requestAnimationFrame(() => { updateSummary(); updateWeeklyChart(); });
});
tabHistoryBtn.addEventListener("click", switchToHistory);
prevMonthBtn.addEventListener("click", () => {
  if (historyDate.month === 1) { historyDate.month = 12; historyDate.year--; } else { historyDate.month--; }
  loadHistoryMonth(historyDate.year, historyDate.month);
});
nextMonthBtn.addEventListener("click", () => {
  if (historyDate.month === 12) { historyDate.month = 1; historyDate.year++; } else { historyDate.month++; }
  loadHistoryMonth(historyDate.year, historyDate.month);
});
jumpToCurrentBtn.addEventListener("click", () => { historyDate = { ...NOW_YM }; loadHistoryMonth(historyDate.year, historyDate.month); });
document.getElementById("viewAllBtn").addEventListener("click", () => {
  switchToHistory();
  if (historyLoaded) { historyDate = { ...NOW_YM }; loadHistoryMonth(historyDate.year, historyDate.month); }
});

// ── 触感反馈 ──────────────────────────────────────────
const press = (el, cls) => {
  if (!el) return;
  el.addEventListener("pointerdown", () => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); });
  el.addEventListener("animationend", () => el.classList.remove(cls));
};
press(document.getElementById("saveExpenseBtn"), "btn-pressed");
press(document.getElementById("exportCsvBtn"),   "btn-pressed");
document.querySelectorAll(".cat-label").forEach(lbl => {
  const opt = lbl.querySelector(".cat-option");
  if (!opt) return;
  lbl.addEventListener("pointerdown", () => { opt.classList.remove("cat-tapped"); void opt.offsetWidth; opt.classList.add("cat-tapped"); });
  opt.addEventListener("animationend", () => opt.classList.remove("cat-tapped"));
});

// ── 导出 CSV ──────────────────────────────────────────
document.getElementById("exportCsvBtn").addEventListener("click", async () => {
  const btn = document.getElementById("exportCsvBtn");
  btn.disabled = true; btn.textContent = "导出中…";
  try {
    const { data, error } = await sb.from("expenses").select("*")
      .eq("family_code", AS.session.familyCode).order("created_at", { ascending: false });
    if (error || !data) { showToast("导出失败，请检查网络"); return; }
    const esc = v => { const s = v == null ? "" : String(v); return (s.includes(",") || s.includes("\n") || s.includes('"')) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = data.map(r => {
      const d = new Date(r.created_at);
      return [
        `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`,
        `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`,
        r.member || "", r.category || "", r.name || "", Number(r.amount).toFixed(2), r.note || "",
      ].map(esc).join(",");
    });
    const csv  = ["日期,时间,成员,分类,名称,金额,备注", ...rows].join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement("a"), { href: url, download: `账单_${AS.session.familyCode}_${getDateKey(new Date()).replace(/-/g, "")}.csv` });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`已导出 ${data.length} 条账单 ✓`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v13M7 11l5 5 5-5"/><path d="M5 21h14"/></svg> 导出全部账单为 CSV`;
  }
});

// ── 清空今日 ──────────────────────────────────────────
clearTodayBtn.addEventListener("click", async () => {
  const todayKey   = getDateKey(new Date());
  const todayItems = AS.expenses.filter(item => getDateKey(new Date(item.timestamp)) === todayKey);
  if (!todayItems.length) { showToast("今天还没有记录可清空"); return; }
  if (!confirm(`确认清空今日 ${todayItems.length} 条记录吗？此操作不可撤销。`)) return;
  clearTodayBtn.disabled = true; clearTodayBtn.textContent = "清空中…";
  const todayIds = new Set(todayItems.map(i => i.id));
  AS.expenses = AS.expenses.filter(i => !todayIds.has(i.id));
  saveExpenseCache(AS.session.familyCode, AS.expenses);
  clearHistoryCache(AS.session.familyCode);
  refreshView();
  await Promise.all([...todayIds].map(id => deleteExpenseFromCloud(id)));
  clearTodayBtn.disabled = false; clearTodayBtn.textContent = "清空今日数据";
  showToast(`已清空今日 ${todayItems.length} 条记录 ✓`);
});

// ── PWA ───────────────────────────────────────────────
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
const hideInstall  = () => { installPrompt.classList.add("hidden"); installPrompt.classList.remove("flex"); };
const showInstall  = (msg, canInstall) => {
  if (isStandalone()) { hideInstall(); return; }
  installHintText.textContent = msg; installAppBtn.disabled = !canInstall;
  installPrompt.classList.remove("hidden"); installPrompt.classList.add("flex");
};

if ("serviceWorker" in navigator)
  window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}); });

let installEventReceived = false, installCheckTimer = null;
if (isStandalone()) { hideInstall(); }
else if (!window.isSecureContext) { showInstall("当前不是安全环境，安装功能需要通过 https 或 localhost 打开。", false); }
else {
  showInstall("正在检查安装条件，请稍候…", false);
  installCheckTimer = setTimeout(() => {
    if (!installEventReceived && !deferredInstallPrompt)
      showInstall("暂未触发安装事件。可继续浏览后重试，或用 Chrome 菜单手动安装。", true);
  }, 5000);
}
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault(); installEventReceived = true;
  if (installCheckTimer) { clearTimeout(installCheckTimer); installCheckTimer = null; }
  deferredInstallPrompt = e;
  showInstall("可安装到桌面，点击右侧按钮即可安装。", true);
});
installAppBtn.addEventListener("click", async () => {
  if (!deferredInstallPrompt) { showInstall('当前未触发系统安装弹窗。请在 Chrome 地址栏右侧或菜单中选择\u201c安装应用\u201d。', true); return; }
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  if (choice.outcome === "accepted") hideInstall();
  else showInstall("你已取消安装，可稍后再次点击安装。", true);
  deferredInstallPrompt = null;
});
window.addEventListener("appinstalled", () => { hideInstall(); deferredInstallPrompt = null; });

// ── 启动 ──────────────────────────────────────────────
_splashShownAt = performance.now();
dateInput.value = dateInput.max = getDateKey(new Date());
AS.session = loadSession();
if (AS.session) { initApp(); }
else { loginOverlay.classList.remove("hidden"); initLoginUI(); dismissSplashScreen(); }
