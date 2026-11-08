#!/usr/bin/env node
// [APP-FIX-087] 手机面板照抄 PC 的决策区（online.rs render_decision/render_luck 口径）：
//   运气行：期望 E（±S，档）—— 来自引擎 scenario_extra.expected_*
//   首选：{描述} {+Δ}，Δ = 该候选分 − 本回合基线（引擎 JSON 暂无 baseline 时用候选分均值近似）
//   #2/#3：其余候选按分排序，显示 Δ
//   数据源：GET /engine → {"decision":{turn,score,action_index,expected_score,expected_stdev,
//                              expected_rank,descriptions,scores}}
const fs = require('fs');
const H = process.argv[2];
if (!H) throw new Error('usage: apply_appfix_087.js <index.html>');
let h = fs.readFileSync(H, 'utf8');
if (h.includes('[APP-FIX-087]')) { console.log('already applied'); process.exit(0); }
const anchor = "  document.getElementById('a-advice').textContent=f?`本回合教诲：暂无転成；稽古步数 ${n(f.act_training_step)}`:'等待当前盘面的建议';";
if (!h.includes(anchor)) throw new Error('anchor missing');
const js = [
"  // [APP-FIX-087] PC 同款决策区：问引擎 /engine，渲染 期望(±S,档) + 首选Δ + Top3Δ",
"  try {",
"    if (!window.__engTimer) {",
"      window.__engTimer = setInterval(async function(){",
"        try {",
"          const r = await fetch('/engine', {cache:'no-store'});",
"          const j = await r.json();",
"          const d = j && j.decision;",
"          const box = document.getElementById('a-advice');",
"          if (!box) return;",
"          if (!d) { box.textContent = '引擎：' + (j && j.status ? j.status : '未就绪'); return; }",
"          const scores = Array.isArray(d.scores) ? d.scores.slice() : [];",
"          const descs = Array.isArray(d.descriptions) ? d.descriptions.slice() : [];",
"          if (!scores.length) { box.textContent = '引擎：无候选分'; return; }",
"          const mean = scores.reduce(function(a,b){return a+b;},0)/scores.length;",
"          const delta = function(v){ const x = Math.round(v-mean); return (x>=0?'+':'')+x; };",
"          const idx = [];",
"          for (let i=0;i<scores.length;i++) idx.push(i);",
"          idx.sort(function(a,b){return scores[b]-scores[a];});",
"          const ch = (typeof d.action_index === 'number') ? d.action_index : idx[0];",
"          const head = '期望 ' + n(d.expected_score) + '（±' + n(d.expected_stdev) + '，' + (d.expected_rank||'—') + '）';",
"          const top = '首选：' + (descs[ch]||('#'+ch)) + ' ' + delta(scores[ch]);",
"          const rest = [];",
"          let rank = 2;",
"          for (const i of idx) { if (i===ch) continue; if (rank>3) break; rest.push('#'+rank+' '+ (descs[i]||('#'+i)) +' '+delta(scores[i])); rank++; }",
"          box.innerHTML = '<b style=\"color:#2a7ad1\">'+head+'</b><br>'+top+'<br><span style=\"font-size:12px\">'+rest.join('　')+'</span>';",
"        } catch (e) { }",
"      }, 2000);",
"    }",
"  } catch (e) { }",
].join('\n');
h = h.replace(anchor, anchor + '\n' + js);
fs.writeFileSync(H, h);
console.log('app-fix-087 applied');