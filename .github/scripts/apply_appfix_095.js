#!/usr/bin/env node
// [APP-FIX-095]
// 1) 页面数据源改成「同源」：App 自己就是 HTTP 服务（18766 被 DSH 占用时会落到 18764），
//    页面原来的 state.base 写死 http://127.0.0.1:18766 → 打到别人端口上，所以永远「未连接」。
//    location.origin 永远等于 App 实际绑定的端口。
// 2) 人头/角标按真实字段渲染：
//    partner_type: 2=支援卡 1=友人卡 0=NPC；support_card_type 同理；
//    is_tips_event=叹号(Hint)，is_unique_active=亮起，is_shining=彩圈(友情前提)，
//    current_bond/bond_threshold 直接显示。删掉写死的「一般 NPC / 理事长 / 记者 / 友人」占位行。
const fs = require('fs');
const H = process.argv[2];
if (!H) throw new Error('usage: apply_appfix_095.js <index.html>');
let h = fs.readFileSync(H, 'utf8');
if (h.includes('[APP-FIX-095]')) { console.log('already applied'); process.exit(0); }
const once = (a, b) => {
  const n = h.split(a).length - 1;
  if (n !== 1) { console.log('skip(count=' + n + '): ' + JSON.stringify(a.slice(0, 50))); return; }
  h = h.split(a).join(b);
};

// 1) 数据源 = 同源（跟着 App 实际端口走）
once(
  "let state={polling:true, source:\"live\", base:\"http://127.0.0.1:18766\", frame:null, frames:0,",
  "// [APP-FIX-095] 同源：App 的 HTTP 端口可能不是 18766（被占用时落到 18764/18772/18773）\nlet state={polling:true, source:\"live\", base:(location&&location.origin&&location.origin!=='null'?location.origin:'http://127.0.0.1:18766'), frame:null, frames:0,"
);
once(
  "<div class=\"row\"><span class=\"k\">数据入口</span><span class=\"v mono\" id=\"v-inport\">本机 · 127.0.0.1:18766</span></div>",
  "<div class=\"row\"><span class=\"k\">数据入口</span><span class=\"v mono\" id=\"v-inport\">本机 · 当前端口</span></div>"
);
once(
  "<input id=\"s-base\" value=\"http://127.0.0.1:18766\"></div>",
  "<input id=\"s-base\" value=\"\"></div>"
);

// 2) 人头/角标：真实字段
once(
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
  "    }",
  "    // [APP-FIX-095] 人头/角标全部按真实字段渲染（partner_type 2=卡 1=友人 0=NPC）\n" +
  "    const cmdId=5101+idx;\n" +
  "    const tr=(f.trainings||[]).find(function(t){return +t.command_id===cmdId;})||{};\n" +
  "    const ppl=(tr.partners||[]).slice(0,5);\n" +
  "    const badge=function(p){\n" +
  "      let b='';\n" +
  "      if(p.is_shining===true) b+='<i class=\"bg shine\" title=\"彩圈（友情前提）\">彩</i>';\n" +
  "      if(p.is_tips_event===true) b+='<i class=\"bg tip\" title=\"叹号 Hint\">叹</i>';\n" +
  "      if(p.is_unique_active===true) b+='<i class=\"bg on\" title=\"亮起（担当锁位）\">亮</i>';\n" +
  "      return b;\n" +
  "    };\n" +
  "    let heads='';\n" +
  "    if(ppl.length){\n" +
  "      heads=ppl.map(function(p){\n" +
  "        const pt=+p.partner_type;\n" +
  "        const typ=pt===1?'guest':(pt===2?'card':'npc');\n" +
  "        const nm=esc(p.name||('#'+p.partner_id));\n" +
  "        const bd=(p.current_bond!=null&&p.support_card_id)?(' ·'+p.current_bond):'';\n" +
  "        return '<div class=\"v5-head '+typ+'\"><span class=\"ic\"></span><span class=\"tx\">'+nm+bd+'</span>'+badge(p)+'</div>';\n" +
  "      }).join('');\n" +
  "    } else {\n" +
  "      heads='<div class=\"v5-head npc\"><span class=\"tx\">本轮无站位</span></div>';\n" +
  "    }"
);
once(
  "    // [APP-FIX-093] 末尾补位说明只在没真数据时提示\n    if(!ppl.length) heads+=v5Head('npc','一般 NPC（随机角标）',false)+v5Head('social','理事长 / 记者',true);",
  "    // [APP-FIX-095] 不再追加写死的 NPC / 理事长 / 记者 占位——真实站位已经在上面按 partners 渲染"
);
once(
  "/* 人头规则表 */",
  "/* [APP-FIX-095] 人头角标 */\n" +
  ".bg{display:inline-block;min-width:14px;margin-left:3px;padding:0 2px;border-radius:3px;font-size:9px;line-height:13px;text-align:center;font-style:normal;color:#fff}\n" +
  ".bg.shine{background:#d24c9b}.bg.tip{background:#3f9e58}.bg.on{background:#2a6fb3}\n" +
  "/* 人头规则表 */"
);

fs.writeFileSync(H, h);
console.log('app-fix-095 applied');