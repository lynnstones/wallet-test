import { createClient } from '@supabase/supabase-js';
import { S } from './state.js';
import { currentYM } from './utils.js';

const SUPABASE_URL = "https://mcqfnlcwenrzoucsbdwk.supabase.co";
const SUPABASE_KEY = "sb_publishable_5YJxkgjM8E5gCFba6Gz-aQ_gTpr0w5l";
export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

export const EXPENSE_CACHE_KEY   = "wallet_expense_cache_v2";
export const HISTORY_CACHE_KEY   = "wallet_history_cache_v1";
export const PENDING_UPLOADS_KEY = "wallet_pending_uploads_v1";
const        HISTORY_CACHE_TTL   = 30 * 60 * 1000;

// localStorage 读写辅助
const lsGet = (key, def) => { try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : def; } catch { return def; } };
const lsSet = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} };

// ── 本月账单缓存 ──────────────────────────────────────
export function loadExpenseCache(familyCode) {
  const slot = (lsGet(EXPENSE_CACHE_KEY, {}))[familyCode] || {};
  return slot.ym === currentYM() ? (slot.expenses || []) : [];
}
export function saveExpenseCache(familyCode, expenses) {
  const all = lsGet(EXPENSE_CACHE_KEY, {});
  all[familyCode] = { expenses: expenses.slice(0, 1000), syncedAt: Date.now(), ym: currentYM() };
  lsSet(EXPENSE_CACHE_KEY, all);
}

// ── 历史月份缓存 ──────────────────────────────────────
export function loadHistoryCache(familyCode, year, month) {
  const entry = ((lsGet(HISTORY_CACHE_KEY, {}))[familyCode] || {})[`${year}-${month}`];
  if (!entry) return null;
  const n = new Date();
  if (year === n.getFullYear() && month === n.getMonth() + 1) return null;
  if (Date.now() - entry.cachedAt > HISTORY_CACHE_TTL) return null;
  return entry.expenses;
}
export function saveHistoryCache(familyCode, year, month, expenses) {
  const all = lsGet(HISTORY_CACHE_KEY, {});
  if (!all[familyCode]) all[familyCode] = {};
  all[familyCode][`${year}-${month}`] = { expenses, cachedAt: Date.now() };
  const keys = Object.keys(all[familyCode]).sort().reverse();
  if (keys.length > 6) keys.slice(6).forEach(k => delete all[familyCode][k]);
  lsSet(HISTORY_CACHE_KEY, all);
}
export function clearHistoryCache(familyCode) {
  const all = lsGet(HISTORY_CACHE_KEY, {});
  if (all[familyCode]) { delete all[familyCode]; lsSet(HISTORY_CACHE_KEY, all); }
}

// ── 离线待上传队列 ────────────────────────────────────
export const loadPendingUploads = () => lsGet(PENDING_UPLOADS_KEY, []);
export const savePendingUploads = (q) => lsSet(PENDING_UPLOADS_KEY, q);

// ── 云端 I/O ──────────────────────────────────────────
export async function saveExpenseToCloud(record) {
  const { session } = S;
  const { error } = await sb.from("expenses").insert({
    id: record.id, family_code: session.familyCode, member: session.member,
    name: record.name, amount: record.amount, category: record.category,
    note: record.note || null, created_at: record.timestamp,
  });
  if (error) {
    const q = loadPendingUploads();
    if (!q.some(r => r.id === record.id))
      q.push({ ...record, _familyCode: session.familyCode, _member: session.member });
    savePendingUploads(q);
    S.showToast("⚠️ 网络异常，账单已存本地稍后同步");
  }
}

export async function flushPendingUploads() {
  const q = loadPendingUploads();
  if (!q.length) return;
  const { session } = S;
  const failed = [];
  for (const r of q) {
    const { error } = await sb.from("expenses").insert({
      id: r.id, family_code: r._familyCode || session.familyCode,
      member: r._member || session.member, name: r.name, amount: r.amount,
      category: r.category, note: r.note || null, created_at: r.timestamp,
    });
    if (error && error.code !== "23505") failed.push(r);
  }
  savePendingUploads(failed);
  const n = q.length - failed.length;
  if (n > 0) S.showToast(`已补传 ${n} 条离线账单 ✓`);
}

export async function fetchFamilyExpenses() {
  const { familyCode } = S.session;
  const n = new Date();
  const start = new Date(n.getFullYear(), n.getMonth(), 1).toISOString();
  const end   = new Date(n.getFullYear(), n.getMonth() + 1, 1).toISOString();
  const { data, error } = await sb.from("expenses").select("*")
    .eq("family_code", familyCode).gte("created_at", start).lt("created_at", end)
    .order("created_at", { ascending: false });
  if (error) { S.showToast("⚠️ 云端读取失败，显示本地缓存"); return loadExpenseCache(familyCode); }
  return (data || []).map(r => ({
    id: r.id, name: r.name, amount: r.amount, category: r.category,
    note: r.note, member: r.member, timestamp: r.created_at, created_at: r.created_at,
  }));
}

export async function deleteExpenseFromCloud(id) {
  if (!id) return false;
  const { error } = await sb.from("expenses").delete()
    .eq("id", id).eq("family_code", S.session.familyCode);
  return !error;
}

export async function fetchFamilyBudget() {
  const { data, error } = await sb.from("family_settings").select("monthly_budget")
    .eq("family_code", S.session.familyCode).maybeSingle();
  return (!error && data) ? data.monthly_budget : null;
}

export async function saveFamilyBudgetToCloud(value) {
  await sb.from("family_settings").upsert(
    { family_code: S.session.familyCode, monthly_budget: value, updated_at: new Date().toISOString() },
    { onConflict: "family_code" }
  );
}

export async function fetchLastMonthTotal() {
  const now = new Date();
  const y = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const m = now.getMonth() === 0 ? 12 : now.getMonth();
  const { data, error } = await sb.from("expenses").select("amount")
    .eq("family_code", S.session.familyCode)
    .gte("created_at", new Date(y, m - 1, 1).toISOString())
    .lt("created_at",  new Date(y, m,     1).toISOString());
  if (error || !data) return 0;
  return data.reduce((s, r) => s + Number(r.amount), 0);
}

export async function syncFamilyMembers(onComplete) {
  const { familyCode, member } = S.session;
  let members = [];
  const { data: fd, error: fe } = await sb.from("families").select("member").eq("family_code", familyCode);
  if (!fe && fd?.length) {
    members = [...new Set(fd.map(r => r.member).filter(Boolean))];
  } else {
    const { data: ed } = await sb.from("expenses").select("member").eq("family_code", familyCode).limit(500);
    if (!ed?.length) { onComplete?.(); return; }
    const freq = {};
    ed.forEach(r => { if (r.member) freq[r.member] = (freq[r.member] || 0) + 1; });
    members = Object.entries(freq).sort((a, b) => b[1] - a[1]).map(([m]) => m);
  }
  if (!members.length) { onComplete?.(); return; }
  const local = S.loadFamilies();
  if (!local.families[familyCode]) local.families[familyCode] = { lastMember: member, members: [] };
  const fam = local.families[familyCode];
  members.forEach(m => { if (!fam.members.includes(m)) fam.members.push(m); });
  fam.lastMember   = member;
  local.lastFamily = familyCode;
  S.saveFamilies(local);
  onComplete?.();
}

export async function registerAllLocalFamilies() {
  const local = S.loadFamilies();
  const rows  = [];
  Object.entries(local.families || {}).forEach(([family_code, fam]) => {
    const members = fam.members?.length ? fam.members : fam.lastMember ? [fam.lastMember] : [];
    members.forEach(member => rows.push({ family_code, member, updated_at: new Date().toISOString() }));
  });
  if (rows.length) await sb.from("families").upsert(rows, { onConflict: "family_code,member" });
}
