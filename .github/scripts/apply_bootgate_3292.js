#!/usr/bin/env node
// [BOOTGATE-3292] 两个真机问题：
//  1) /summary 不在 BOOT_SAFE 白名单里 → 插件晚加载（on_game_initialized 没触发）时永远返回
//     {"status":"booting"}，App/悬浮窗就显示「等待游戏连接」。
//  2) 首次读到育成数据后应把 GAME_INITIALIZED 置 true，避免门禁永远关着。
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
if (s.includes('[BOOTGATE-3292]')) { console.log('already applied'); process.exit(0); }

const anchor = '            "/skilldata",\n            "/debug/table",';
if (!s.includes(anchor)) throw new Error('boot-safe anchor missing');
s = s.replace(anchor,
  '            "/skilldata",\n' +
  '            // [BOOTGATE-3292] 晚加载时也要能读育成数据（门禁不能只看 on_game_initialized）\n' +
  '            "/summary",\n' +
  '            "/debug/festa_probe",\n' +
  '            "/debug/table",');

const a2 = '    log_predict_step("S:festa");\n    let mut __out = __json_out;';
if (!s.includes(a2)) throw new Error('summary tail anchor missing');
s = s.replace(a2,
  '    // [BOOTGATE-3292] 已经能读到育成数据 → 置位，后续所有端点放行\n' +
  '    GAME_INITIALIZED.store(true, Ordering::Relaxed);\n' +
  '    log_predict_step("S:festa");\n    let mut __out = __json_out;');

fs.writeFileSync(P, s);
console.log('bootgate patch applied');