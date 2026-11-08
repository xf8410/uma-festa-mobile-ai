#!/usr/bin/env node
// [APP-FIX-101] 盘面改由**引擎**的回合快照 view 渲染（不再用 SO/页面自算）：
//   view.board.distribution[5][*] = {person, shining}；view.board.persons[] = {origin,card_id,chara_id,friendship,hint,available}
//   view.resources.act_gauge/act_level/act_gauge_max；view.schedule.goal_races/optional_races；view.camp
// 口径与 PC 面板（matsuri-cli/src/panel.rs）一致：卡位彩圈=引擎 shining、NPC 灰、友人绿。
const fs = require('fs');
const I = process.argv[2];
if (!I) throw new Error('usage: apply_appfix_101.js <index.html>');
let h = fs.readFileSync(I, 'utf8');
if (h.includes('[APP-FIX-101]')) { console.log('already applied'); process.exit(0); }

const timerAnchor = "          box.innerHTML = html;";
if (!h.includes(timerAnchor)) throw new Error('timer anchor missing');
h = h.replace(timerAnchor, timerAnchor + "\n          // [APP-FIX-101] 引擎回合快照 → 盘面按 view 渲染\n          try { if (d.view) { window.__VIEW = d.view; if (window.renderFromView) window.renderFromView(d.view); } } catch (e) {}");

const anchor = 'let boardZ = 0.42;';
if (!h.includes(anchor)) throw new Error('board anchor missing');
const fn = [
  '// [APP-FIX-101] 用引擎快照渲染盘面（人头/彩圈/演目槽/赛程）；数据源 = matsuri 引擎的 MatsuriView',
  'window.renderFromView = function(v){',
  '  try {',
  '    const cols = document.querySelectorAll("#a-board .col");',
  '    const persons = (v.board && v.board.persons) || [];',
  '    const dist = (v.board && v.board.distribution) || [];',
  '    const NM = ["速","耐","力","根","智"];',
  '    const shortName = function(p){',
  '      if (p && p.card_id) { const n = cardShort(p.card_id); if (n) return n; }',
  '      if (p && p.chara_id) return "[" + (p.origin === "guest" ? "NPC" : (p.origin === "friend" ? "友" : "?")) + "]" + p.chara_id;',
  '      return "?";',
  '    };',
  '    for (let t = 0; t < 5 && t < cols.length; t++) {',
  '      const box = cols[t].querySelector(".v5-heads");',
  '      if (!box) continue;',
  '      const row = dist[t] || [];',
  '      if (!row.length) { box.innerHTML = \'<div class="v5-head npc"><span class="tx">空位</span></div>\'; continue; }',
  '      box.innerHTML = row.map(function(m){',
  '        const p = persons[m.person] || {};',
  '        const pt = p.origin;',
  '        const typ = (pt === "friend") ? "guest" : ((pt === "card") ? "card" : "npc");',
  '        let b = \'\';',
  '        if (m.shining) b += \'<i class="bg shine" title="彩圈（引擎判定）">彩</i>\';',
  '        if (p.hint) b += \'<i class="bg tip" title="叹号">叹</i>\';',
  '        const bd = (p.friendship != null && pt === "card") ? (" ·" + p.friendship) : "";',
  '        return \'<div class="v5-head \' + typ + \'"><span class="ic"></span><span class="tx">\' + esc(shortName(p) + bd) + \'</span>\' + b + \'</div>\';',
  '      }).join("");',
  '    }',
  '    const r = v.resources || {}, sched = v.schedule || {}, camp = v.camp || {};',
  '    const g = r.act_gauge || [], lv = r.act_level || [], gm = r.act_gauge_max || 0;',
  '    let line = "演目槽：" + NM.map(function(_, i){ return NM[i] + " " + (lv[i]||0) + "Lv " + (g[i]||0) + "/" + (gm||"-"); }).join(" · ");',
  '    if (camp && camp.remain != null) line += "　合宿剩 " + camp.remain;',
  '    line += "　本轮追加稽古: " + (r.kensan_pending ? "已掷中" : "—");',
  '    const goal = sched.goal_races || [], opt = sched.optional_races || [];',
  '    if (goal.length) line += "<br>目标赛：T" + goal.join(" T");',
  '    if (opt.length) line += "　自选赛：T" + opt.join(" T");',
  '    const nt = document.getElementById("a-boardnote");',
  '    if (nt) nt.innerHTML = "📊 " + line;',
  '  } catch (e) { }',
  '};',
].join('\n');
h = h.replace(anchor, fn + '\n' + anchor);
fs.writeFileSync(I, h);
console.log('app-fix-101 applied');