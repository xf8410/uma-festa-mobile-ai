#!/usr/bin/env node
// [APP-FIX-103] 连接页 UI 健壮化 + 状态更明确：
//  1) syncConnectUI 里 q() 找不到元素时返回哑元素，避免个别 id 缺失导致整段中止
//     （表现就是按钮一直「开始连接」、徽章一直「检测中…」）
//  2) 徽章/按钮文案按真实状态：已连接（SO 在线且有帧）/ 等育成帧 / SO 未响应 / 接收端未启动
//  3) 按钮文案改成「暂停连接 / 开始连接」（用户口径）
const fs = require('fs');
const I = process.argv[2];
if (!I) throw new Error('usage: apply_appfix_103.js <index.html>');
let h = fs.readFileSync(I, 'utf8');
if (h.includes('[APP-FIX-103]')) { console.log('already applied'); process.exit(0); }

const oldQ = "function syncConnectUI(){\n  const q=id=>document.getElementById(id);";
if (!h.includes(oldQ)) throw new Error('syncConnectUI anchor missing');
const newQ = [
  'function syncConnectUI(){',
  '  // [APP-FIX-103] 找不到元素也不中断（以前任一 id 缺失会让整段 UI 停在初始态）',
  '  const DUMMY={style:{},classList:{toggle:function(){},add:function(){},remove:function(){}},',
  '    set textContent(v){},get textContent(){return "";},set innerHTML(v){},get innerHTML(){return "";},',
  '    set className(v){},get className(){return "";}};',
  '  const q=id=>document.getElementById(id)||DUMMY;',
].join('\n');
h = h.replace(oldQ, newQ);

h = h.replace(
  "  q('btn-connect').textContent=state.polling?'暂停轮询':'恢复轮询';",
  "  q('btn-connect').textContent=state.polling?'暂停连接':'开始连接'; // [APP-FIX-103]"
);

h = h.replace(
  "  if(!svc){ badge.textContent='接收端未启动'; badge.className='badge off'; }\n" +
  "  else if(!so){ badge.textContent='SO 未响应'; badge.className='badge warn'; }\n" +
  "  else { badge.textContent='SO 在线'; badge.className='badge'; }",
  "  if(!svc){ badge.textContent='接收端未启动'; badge.className='badge off'; }\n" +
  "  else if(!so){ badge.textContent='SO 未响应'; badge.className='badge warn'; }\n" +
  "  else if(!f){ badge.textContent='已连接 · 等育成帧'; badge.className='badge warn'; }\n" +
  "  else { badge.textContent='已连接 · SO 在线'; badge.className='badge ok'; } // [APP-FIX-103]"
);

fs.writeFileSync(I, h);
console.log('app-fix-103 applied');