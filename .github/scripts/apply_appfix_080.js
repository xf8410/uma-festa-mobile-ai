#!/usr/bin/env node
// [APP-FIX-080] 接上 SO 的评价分：Kotlin 转发 score/five_score/pt_score，主面板显示真正的预估评分
const fs = require('fs');
const N = process.argv[2];
const H = process.argv[3];
const G = process.argv[4];
let n = fs.readFileSync(N, 'utf8');
if (n.includes('[APP-FIX-080]')) { console.log('already applied'); process.exit(0); }

// 1) Kotlin：frame 里转发评价分字段
const anchor = '            .put("raw", summary)';
const c = n.split(anchor).length - 1;
if (c !== 1) throw new Error('kotlin anchor count=' + c);
n = n.split(anchor).join(`            // [APP-FIX-080] SO 算好的评价分（五维查定 + PT×倍率）
            .put("score", iv(summary, "score"))
            .put("five_score", iv(summary, "five_score"))
            .put("pt_score", iv(summary, "pt_score"))
            .put("skill_score", iv(summary, "skill_score"))
${anchor}`);
fs.writeFileSync(N, n);

// 2) index.html：卡片里的「预估评分」原来错填成 skill_point
let h = fs.readFileSync(H, 'utf8');
const oldLine = "  document.getElementById('f-score').textContent=f?fmt(n(f.skill_point)):'—';";
const cn = h.split(oldLine).length - 1;
if (cn !== 1) throw new Error('html anchor count=' + cn);
h = h.split(oldLine).join(`  // [APP-FIX-080] 预估评分 = SO 的 score（五维查定 + PT），原来错填成技能点
  document.getElementById('f-score').textContent=f?n(f.score):'—';`);
fs.writeFileSync(H, h);

let g = fs.readFileSync(G, 'utf8');
g = g.replace(/versionCode = \d+/, 'versionCode = 22')
     .replace(/versionName = "[^"]*"/, 'versionName = "0.8.0-dsh5"');
fs.writeFileSync(G, g);
console.log('app-fix-080 applied');