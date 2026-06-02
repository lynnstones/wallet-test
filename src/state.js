// ── 极简全局状态中枢 ─────────────────────────────────────
// db.js / charts.js 直接 import S，无需 setter 注入
export const S = {
  session:      null,      // { familyCode, member }
  expenses:     [],        // 当月账单数组
  showToast:    () => {},
  loadFamilies: () => ({ lastFamily: "", families: {} }),
  saveFamilies: () => {},
};
