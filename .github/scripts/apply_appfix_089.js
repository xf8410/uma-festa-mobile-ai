#!/usr/bin/env node
// [APP-FIX-089] 手机面板按 PC 接线渲染「双档」结果：
//   决策（首选/Top3 +Δ）→ 手写档 matsuri（PC 上跟着 AI 点就是手写档在决策）
//   期望 E（±S，档）→ 搜索档 search（scenario_extra.expected_*，已按上游 project_summary 投影）
//   Δ 口径 = 候选分 − 引擎 baseline（PC online.rs render_decision 同款）
// 数据源：GET /engine → {hand:{decision}, search:{decision}, frames, engine_note}
const fs = require('fs');
const H = process.argv[2];
if (!H) throw new Error('usage: apply_appfix_089.js <index.html>');
let h = fs.readFileSync(H, 'utf8');
if (h.includes('[APP-FIX-089]')) { console.log('already applied'); process.exit(0); }
const anchor = "  document.getElementById('a-advice').textContent=f?`本回合教诲：暂无転成；稽古步数 ${n(f.act_training_step)}`:'等待当前盘面的建议';";
if (!h.includes(anchor)) throw new Error('anchor missing');
const js = [
"  // [APP-FIX-089] 双档面板：手写档出首选，搜索档出期望/±S/档（口径同 PC online.rs）",
"  try {",
"    if (!window.__engTimer) {",
"      window.__engTimer = setInterval(async function(){",
"        const box = document.getElementById('a-advice');",
"        if (!box) return;",
"        try {",
"          const r = await fetch('/engine', {cache:'no-store'});",
"          const j = await r.json();",
"          const hand = j && j.hand ? j.hand.decision : null;",
"          const search = j && j.search ? j.search.decision : null;",
"          const pick = hand || search;",
"          if (!pick) {",
"            const st = j ? (j.hand && j.hand.status ? j.hand.status : (j.engine_note||'?')) : '?';",
"            box.textContent = '引擎：' + st;",
"            return;",
"          }",
"          const d = JSON.parse(pick);",
"          const scores = Array.isArray(d.scores) ? d.scores : [];",
"          const descs = Array.isArray(d.descriptions) ? d.descriptions : [];",
"          const base = (typeof d.baseline === 'number' && d.baseline !== 0) ? d.baseline",
"            : (scores.length ? scores.reduce(function(a,b){return a+b;},0)/scores.length : 0);",
"          const dl = function(v){ const x = Math.round(v - base); return (x>=0?'+':'')+x; };",
"          const order = scores.map(function(_,i){return i;}).sort(function(a,b){return scores[b]-scores[a];});",
"          const ch = (typeof d.action_index === 'number' && d.action_index < scores.length) ? d.action_index : order[0];",
"          const head = (function(){",
"            const s = search ? JSON.parse(search) : null;",
"            if (!s || !s.expected_score) return '';",
"            return '<b style=\"color:#2a7ad1\">期望 ' + n(s.expected_score) + '（±' + n(s.expected_stdev) + '，' + (s.expected_rank||'—') + '）</b><br>';",
"          })();",
"          const det = Array.isArray(d.detail) ? d.detail : [];",
"          const td = function(i, c){",
"            const a = det.find(function(x){return x.i===i;}), b = det.find(function(x){return x.i===c;});",
"            if (!a || !b) return '';",
"            const NM = ['速','耐','力','根','智']; let s2 = '';",
"            for (let k=0;k<5;k++){ const v = Math.round(a.five[k]-b.five[k]); if (v!==0) s2 += NM[k]+(v>0?'+':'')+v+' '; }",
"            const pt = Math.round(a.pt-b.pt); if (pt!==0) s2 += 'PT'+(pt>0?'+':'')+pt;",
"            return s2 ? ' (' + s2.trim() + ')' : '';",
"          };",
"          const src = (hand ? '手写' : '搜索');",
"          let html = head + '<b>首选：' + (descs[ch]||('#'+ch)) + ' ' + dl(scores[ch]) + '</b> <span style=\"font-size:11px;color:#888\">(' + src + '档)</span>';",
"          const rest = []; let rank = 2;",
"          for (const i of order) { if (i===ch) continue; if (rank>3) break; rest.push('#'+rank+' '+(descs[i]||('#'+i))+' '+dl(scores[i])+td(i,ch)); rank++; }",
"          if (rest.length) html += '<br><span style=\"font-size:12px\">' + rest.join('　') + '</span>';",
"          box.innerHTML = html;",
"        } catch (e) { box.textContent = '引擎：解析失败'; }",
"      }, 2000);",
"    }",
"  } catch (e) { }",
].join('\n');
h = h.replace(anchor, anchor + '\n' + js);
fs.writeFileSync(H, h);
console.log('app-fix-089 applied');