#!/usr/bin/env node
// [APP-FIX-088] 让手机面板的 Δ 与 PC 完全同口径：
//   EngineBridge.onEngineLine 增加 baseline / detail[{five,pt}]（引擎 JSON 的 candidate_detail）
//   index.html 渲染改用 baseline：首选 Δ = s − baseline；#n 显示 Δ 与 terminal_delta（五维/PT 差）
const fs = require('fs');
const K = process.argv[2];
const H = process.argv[3];
if (!K || !H) throw new Error('usage: apply_appfix_088.js <EngineBridge.kt> <index.html>');
let k = fs.readFileSync(K, 'utf8');
let h = fs.readFileSync(H, 'utf8');
if (k.includes('[APP-FIX-088]')) { console.log('already applied'); process.exit(0); }
const once = (src, a, b) => {
  const n = src.split(a).length - 1;
  if (n !== 1) { console.log('skip (count=' + n + '): ' + JSON.stringify(a.slice(0, 50))); return src; }
  return src.split(a).join(b);
};

// 1) EngineBridge：带上 baseline / detail
k = once(
  k,
  '            d.append("\\"scores\\":").append(o.optJSONArray("candidate_scores")?.toString() ?: "[]")',
  '            d.append("\\"scores\\":").append(o.optJSONArray("candidate_scores")?.toString() ?: "[]").append(",")\n' +
  '            d.append("\\"baseline\\":").append(ex?.optDouble("baseline", 0.0) ?: 0.0).append(",") // [APP-FIX-088]\n' +
  '            d.append("\\"detail\\":").append(ex?.optJSONArray("candidate_detail")?.toString() ?: "[]")'
);

// 2) index.html：Δ 用 baseline，并把 PC 的 (五维/PT 差) 补上
h = once(
  h,
  "          const mean = scores.reduce(function(a,b){return a+b;},0)/scores.length;",
  "          const base = (typeof d.baseline === 'number' && d.baseline !== 0) ? d.baseline : (scores.reduce(function(a,b){return a+b;},0)/scores.length); // [APP-FIX-088] 引擎 baseline 优先\n          const det = Array.isArray(d.detail) ? d.detail : [];\n          const tdelta = function(i, ch){ const a = det.find(function(x){return x.i===i;}), b = det.find(function(x){return x.i===ch;}); if(!a||!b) return ''; const NM=['速','耐','力','根','智']; let s2=''; for(let k2=0;k2<5;k2++){ const v=Math.round(a.five[k2]-b.five[k2]); if(v!==0) s2 += NM[k2]+(v>0?'+':'')+v+' '; } const pt=Math.round(a.pt-b.pt); if(pt!==0) s2 += 'PT'+(pt>0?'+':'')+pt; return s2 ? ' ('+s2.trim()+')' : ''; };"
);
h = once(h, "          const delta = function(v){ const x = Math.round(v-mean); return (x>=0?'+':'')+x; };",
             "          const delta = function(v){ const x = Math.round(v-base); return (x>=0?'+':'')+x; };");
h = once(h, "rest.push('#'+rank+' '+ (descs[i]||('#'+i)) +' '+delta(scores[i])); rank++; }",
             "rest.push('#'+rank+' '+ (descs[i]||('#'+i)) +' '+delta(scores[i]) + tdelta(i, ch)); rank++; }");

fs.writeFileSync(K, k);
fs.writeFileSync(H, h);
console.log('app-fix-088 applied');