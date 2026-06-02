// ── 当前月份标识 "YYYY-MM" ─────────────────────────────
export function currentYM() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`;
}

// ── 分类配置表（全局共享） ──────────────────────────────
export const categoryConfig = {
  "餐饮": { emoji: "🍔", color: "bg-orange-500", chartColor: "#ff9500" },
  "交通": { emoji: "🚗", color: "bg-blue-500",   chartColor: "#007aff" },
  "购物": { emoji: "🛍️", color: "bg-purple-500", chartColor: "#af52de" },
  "娱乐": { emoji: "🎮", color: "bg-pink-500",   chartColor: "#ff2d55" },
  "医疗": { emoji: "💊", color: "bg-red-500",    chartColor: "#ef4444" },
  "居家": { emoji: "🏠", color: "bg-teal-500",   chartColor: "#14b8a6" },
  "通讯": { emoji: "📱", color: "bg-cyan-500",   chartColor: "#06b6d4" },
  "其他": { emoji: "📦", color: "bg-slate-500",  chartColor: "#8e8e93" },
};

// ── 金额格式化 ──────────────────────────────────────────
export function formatMoney(value) {
  return "¥ " + value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── 日期键 (YYYY-MM-DD) ────────────────────────────────
export function getDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ── 从 date input 值 + 当前时间构建 ISO timestamp ───────
export function buildTimestampFromDateInput(dateStr) {
  if (!dateStr) return new Date().toISOString();
  const now = new Date();
  const withCurrentTime = `${dateStr}T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  const selected = new Date(withCurrentTime);
  if (Number.isNaN(selected.getTime())) return new Date().toISOString();
  return selected.toISOString();
}

// ── 数字滚动动画配置 ────────────────────────────────────
const ROLL_DURATION_MS = 1000;
const ROLL_FROM_ZERO   = true;
const _rollFrames = new WeakMap();

// 带 ¥ 前缀的数字滚动（用于大字总支出）
export function animateNumber(el, toVal, duration = ROLL_DURATION_MS) {
  const raw     = (el.textContent || "0").replace(/[^\d.]/g, "");
  const fromVal = ROLL_FROM_ZERO ? 0 : (parseFloat(raw) || 0);

  if (Math.abs(fromVal - toVal) < 0.5) {
    el.textContent = formatMoney(toVal);
    return;
  }

  const prev = _rollFrames.get(el);
  if (prev) cancelAnimationFrame(prev);
  const startTime = performance.now();

  function tick(now) {
    const elapsed = now - startTime;
    const t       = Math.min(elapsed / duration, 1);
    const ease    = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
    const current = fromVal + (toVal - fromVal) * ease;
    el.textContent = "¥ " + Math.round(current).toLocaleString("zh-CN");
    if (t < 1) {
      _rollFrames.set(el, requestAnimationFrame(tick));
    } else {
      el.textContent = formatMoney(toVal);
      _rollFrames.delete(el);
    }
  }

  _rollFrames.set(el, requestAnimationFrame(tick));
}

// 无前缀自定义格式滚动（用于预算数字等）
export function animateNumberRaw(el, toVal, formatter, duration = ROLL_DURATION_MS) {
  const raw     = (el.textContent || "0").replace(/[^\d.]/g, "");
  const fromVal = ROLL_FROM_ZERO ? 0 : (parseFloat(raw) || 0);
  if (Math.abs(fromVal - toVal) < 0.5) { el.textContent = formatter(toVal); return; }
  const prev = _rollFrames.get(el);
  if (prev) cancelAnimationFrame(prev);
  const startTime = performance.now();
  function tick(now) {
    const t    = Math.min((now - startTime) / duration, 1);
    const ease = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
    el.textContent = formatter(Math.round(fromVal + (toVal - fromVal) * ease));
    if (t < 1) { _rollFrames.set(el, requestAnimationFrame(tick)); }
    else        { el.textContent = formatter(toVal); _rollFrames.delete(el); }
  }
  _rollFrames.set(el, requestAnimationFrame(tick));
}
