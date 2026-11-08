#!/usr/bin/env node
// [APP-FIX-104] 连接页语义重做（用户口径）：
//   点一次「开始连接」→ 立刻真连一次（/api/pull 让 App 拉 SO，再读 /api/snapshot）
//   成功 → 按钮变「暂停连接」、徽章「已连接 · SO 在线」（有帧）/「已连接 · 等育成帧」
//   失败 → 徽章「未连接 · SO 未响应」并 toast 原因
//   文案全部动态：端口用 location.port（不再写死 18766），说明改成推送兜底的真实行为
const fs = require('fs');
const I = process.argv[2];
if (!I) throw new Error('usage: apply_appfix_104.js <index.html>');
let h = fs.readFileSync(I, 'utf8');
if (h.includes('[APP-FIX-104]')) { console.log('already applied'); process.exit(0); }
const once = (a, b) => {
  const n = h.split(a).length - 1;
  if (n !== 1) throw new Error('anchor count=' + n + ' for: ' + JSON.stringify(a.slice(0, 60)));
  h = h.split(a).join(b);
};

once(
  'SO 推 /summary → 本机 18766 收；本机后台持续主动拉 18765（推送静默时兜底）。暂停仅停止页面轮询，接收、主动拉取与归档继续。',
  '<span id="conn-hint">SO 推送 /summary → 本机同端口接收（18766 被别的服务占用时，SO 会自动改推 18764/18772/18773）；App 后台同时主动拉 18765。暂停只停页面轮询，接收与归档继续。</span> <!-- [APP-FIX-104] -->'
);

once(
  "  q('v-service').textContent=svc?'运行中 · 18766':'未启动';",
  "  q('v-service').textContent=svc?('运行中 · :'+(location.port||'?')):'未启动'; // [APP-FIX-104]"
);

once(
  "  if(!svc){ badge.textContent='接收端未启动'; badge.className='badge off'; }\n" +
  "  else if(!so){ badge.textContent='SO 未响应'; badge.className='badge warn'; }\n" +
  "  else if(!f){ badge.textContent='已连接 · 等育成帧'; badge.className='badge warn'; }\n" +
  "  else { badge.textContent='已连接 · SO 在线'; badge.className='badge ok'; } // [APP-FIX-103]",
  "  // [APP-FIX-104] 状态语义：暂停 / 未连接 / 已连接(等帧) / 已连接(在线)\n" +
  "  if(!state.polling){ badge.textContent='已暂停'; badge.className='badge off'; }\n" +
  "  else if(!svc){ badge.textContent='未连接 · 接收端未启动'; badge.className='badge off'; }\n" +
  "  else if(!so){ badge.textContent='未连接 · SO 未响应'; badge.className='badge warn'; }\n" +
  "  else if(!f){ badge.textContent='已连接 · 等育成帧'; badge.className='badge warn'; }\n" +
  "  else { badge.textContent='已连接 · SO 在线'; badge.className='badge ok'; }"
);

once(
  "function toggleConnect(){\n" +
  "  state.polling=!state.polling;\n" +
  "  if(state.polling){ startPolling(); toast('已恢复轮询 · 立即重连'); }\n" +
  "  else { if(state.timer){clearInterval(state.timer);state.timer=null;} toast('已暂停页面轮询 · 接收端与归档仍在运行'); }\n" +
  "  syncConnectUI();\n" +
  "}",
  [
    "async function toggleConnect(){",
    "  // [APP-FIX-104] 点一次就真连一次：拉 SO → 读快照 → 立刻回写按钮/徽章",
    "  if(state.polling){",
    "    state.polling=false;",
    "    if(state.timer){clearInterval(state.timer);state.timer=null;}",
    "    syncConnectUI();",
    "    toast('已暂停连接 · 接收端仍在后台运行');",
    "    return;",
    "  }",
    "  state.polling=true;",
    "  const btn=document.getElementById('btn-connect');",
    "  if(btn){ btn.textContent='连接中…'; }",
    "  try{ await pullNow(); }catch(e){}",
    "  let ok=false;",
    "  try{",
    "    const r=await fetch(state.base+'/api/snapshot',{cache:'no-store'});",
    "    if(r.ok){ const s=await r.json(); ok=(s.so_alive===true); }",
    "  }catch(e){}",
    "  startPolling();",
    "  syncConnectUI();",
    "  toast(ok?'已连接 · SO 在线':'未连接 · SO 未响应（游戏里 SO 可能没起来）');",
    "}"
  ].join('\n')
);

once(
  "function setOffline(msg){\n  state.service=false; state.soAlive=false; state.frame=null; state.latestSource='none';\n  syncConnectUI();",
  "function setOffline(msg){\n  state.service=false; state.soAlive=false; state.frame=null; state.latestSource='none';\n  syncConnectUI(); // [APP-FIX-104] 让徽章立刻显示「未连接」，不再停在检测中"
);

fs.writeFileSync(I, h);
console.log('app-fix-104 applied');