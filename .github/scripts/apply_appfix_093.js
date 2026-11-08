#!/usr/bin/env node
// [APP-FIX-093] 面板两处优化：
//  1) 人头显示用真数据（/summary 的 trainings[].partners：支援卡 id / 名字 / 羁绊 / 是否亮起），
//     不再显示「支援卡人头（占位）」占位符
//  2) 缩放改成随时可拉伸：页面实现 window.setZoom（悬浮窗缩放按钮真正生效），
//     盘面缩放范围放宽到 0.1~3.0，「适配」也能放大
const fs = require('fs');
const H = process.argv[2];
if (!H) throw new Error('usage: apply_appfix_093.js <index.html>');
let h = fs.readFileSync(H, 'utf8');
if (h.includes('[APP-FIX-093]')) { console.log('already applied'); process.exit(0); }
const once = (a, b) => {
  const n = h.split(a).length - 1;
  if (n !== 1) { console.log('skip(count=' + n + '): ' + JSON.stringify(a.slice(0, 46))); return; }
  h = h.split(a).join(b);
};

// 1) 人头：真数据
once(
  "    let heads=lit?(v5Head('link',a.guest+'（担当锁定）',false)+v5Head('card','担当支援卡 ×N',false))\n                 :v5Head('card','支援卡人头（占位）',false);",
  "    // [APP-FIX-093] 人头用真数据：trainings[command_id].partners\n" +
  "    const cmdId=5101+idx;\n" +
  "    const tr=(f.trainings||[]).find(function(t){return +t.command_id===cmdId;})||{};\n" +
  "    const ppl=(tr.partners||[]).slice(0,5);\n" +
  "    let heads='';\n" +
  "    if(ppl.length){\n" +
  "      heads=ppl.map(function(p){\n" +
  "        const nm=esc(p.name||('#'+p.partner_id));\n" +
  "        const bd=(p.current_bond!=null)?(' ·'+p.current_bond):'';\n" +
  "        const typ=p.support_card_id?'card':'npc';\n" +
  "        return v5Head(typ, nm+bd, !p.is_unique_active);\n" +
  "      }).join('');\n" +
  "    } else {\n" +
  "      heads=v5Head('card','人头未推('+(tr.heads||0)+'人)',false);\n" +
  "    }"
);
once(
  "    heads+=v5Head('npc','一般 NPC（随机角标）',false)+v5Head('social','理事长 / 记者',true)+v5Head('guest','友人·吾妻（必补位）',true);",
  "    // [APP-FIX-093] 末尾补位说明只在没真数据时提示\n" +
  "    if(!ppl.length) heads+=v5Head('npc','一般 NPC（随机角标）',false)+v5Head('social','理事长 / 记者',true);"
);

// 2) 缩放：范围放宽
once(
  "  boardZ = Math.max(.25, Math.min(1.4, +z.toFixed(3)));",
  "  boardZ = Math.max(.1, Math.min(3.0, +z.toFixed(3))); // [APP-FIX-093] 随时可拉伸"
);
once(
  "  setBoardZoom(Math.max(.25, Math.min(1, w / nat)));",
  "  setBoardZoom(Math.max(.1, Math.min(3.0, w / nat))); // [APP-FIX-093] 适配也能放大"
);

// 3) 页面级缩放（悬浮窗按钮调用它）
once(
  "/* ===== 电脑版原样盘面（1:1 复刻视图） ===== */",
  "// [APP-FIX-093] 页面级缩放：悬浮窗的 ⤢ 按钮改窗口宽度 + CSS zoom，这里让 zoom 真正生效\n" +
  "window.setZoom = function(z){\n" +
  "  const v = Math.max(.35, Math.min(2.0, +z || 1));\n" +
  "  document.documentElement.style.zoom = v;\n" +
  "};\n" +
  "/* ===== 电脑版原样盘面（1:1 复刻视图） ===== */"
);

fs.writeFileSync(H, h);
console.log('app-fix-093 applied');