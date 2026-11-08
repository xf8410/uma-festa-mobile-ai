// 技能规划口径（对齐 URA-Plugins/SkillTipsResponseAnalyzer 的验证记录，见 docs/skilltips-rewrite.md）
// 1) 属性分：逐维 StatusToPoint(v) 求和；v<=2000 查表，>2000 用公式
//    14280 + (183*d + 25*q*(q-1)/2 + q*r + 1)/10, d=v-2000, q=d/25, r=d%25（整数除法）
// 2) 技能分：基础分 × 脚质倍率 × 距离倍率，**每技能取整一次**（Math.Round = round-half-even）
// 3) 费用：(基础费 × (1 - 折扣)) 向下取整；折扣 = 切者10% / 勤勉好学4%（同组取切者）+ Hint 折扣
// 4) 求解：同基础技能分组做多选背包（不买/买某档），预算内最大化总分，同分最少花费
// 分工：SO 只给「已学技能 + tips + PT + master 表（skill_data）」，计算与 UI 都在 App（Kotlin 移植本文件）

function statusToPoint(v, table) {
  v = Math.floor(v);
  if (!(v > 0)) return 0;
  if (v <= 2000 && table) return table[v] | 0;
  if (v <= 2000) return 0;
  const d = v - 2000;
  const q = Math.floor(d / 25);
  const r = d % 25;
  const num = 183 * d + (25 * q * (q - 1)) / 2 + q * r + 1;
  return 14280 + Math.floor(num / 10);
}

function totalStatusPoint(five, table) {
  let sum = 0;
  for (const v of five) sum += statusToPoint(v, table);
  return sum;
}

function skillScore(base, styleMult, distMult) {
  const raw = base * (styleMult ?? 1) * (distMult ?? 1);
  const floor = Math.floor(raw);
  const frac = raw - floor;
  if (frac > 0.5) return floor + 1;
  if (frac < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

const EFFECT_QIEZHE = 7;
const EFFECT_FIRST = 40;
function discountPct({ qiezhe = false, first = false } = {}) {
  if (qiezhe) return 10;
  if (first) return 4;
  return 0;
}

function skillCost(baseCost, { hintLevel = 0, qiezhe = false, first = false, hintPctPerLevel = 10 } = {}) {
  const pct = discountPct({ qiezhe, first }) + Math.max(0, Math.min(hintLevel, 5)) * hintPctPerLevel;
  return Math.max(0, Math.floor(baseCost * (100 - Math.min(pct, 100)) / 100));
}

function planSkills(groups, budget) {
  const B = Math.max(0, Math.floor(budget));
  let dp = new Array(B + 1).fill(null);
  dp[0] = { score: 0, cost: 0, picks: [] };
  for (const g of groups) {
    const nd = dp.slice();
    for (let b = 0; b <= B; b++) {
      const cur = dp[b];
      if (!cur) continue;
      for (const o of g.options) {
        const nb = b + o.cost;
        if (nb > B) continue;
        const cand = { score: cur.score + o.score, cost: cur.cost + o.cost, picks: cur.picks.concat([o.id]) };
        const ex = nd[nb];
        if (!ex || cand.score > ex.score || (cand.score === ex.score && cand.cost < ex.cost)) nd[nb] = cand;
      }
    }
    dp = nd;
  }
  let best = null;
  for (const st of dp) {
    if (!st) continue;
    if (!best || st.score > best.score || (st.score === best.score && st.cost < best.cost)) best = st;
  }
  return best || { score: 0, cost: 0, picks: [] };
}

module.exports = { statusToPoint, totalStatusPoint, skillScore, skillCost, planSkills, discountPct };

// --- 自检（node skill_plan_all.js 直接跑）---
if (require.main === module) {
  const assert = require('assert');
  assert.strictEqual(statusToPoint(2001), 14298);                       // d=1 → +18
  assert.strictEqual(statusToPoint(2025), 14280 + 457);                 // d=25 → +457
  assert.strictEqual(skillScore(217, 0.9, 1.1), 215);                   // 逐次取整会得 214
  assert.strictEqual(skillScore(217, 0.8, 0.9), 156);                   // 逐次取整会得 157
  assert.strictEqual(skillScore(217, 0.5, 1), 108);                     // .5 → half-even
  assert.strictEqual(skillCost(112, {}), 112);
  assert.strictEqual(skillCost(112, { qiezhe: true }), Math.floor(112 * 0.9));
  assert.strictEqual(skillCost(112, { qiezhe: true, hintLevel: 3 }), Math.floor(112 * 0.6));
  const groups = [
    { key: 'a', options: [{ id: 202812, cost: 112, score: 156 }] },
    { key: 'b', options: [{ id: 201132, cost: 140, score: 157 }] },
  ];
  assert.deepStrictEqual(planSkills(groups, 140).picks, [201132]);
  assert.deepStrictEqual(planSkills(groups, 112).picks, [202812]);
  console.log('skill_plan self-test passed');
}