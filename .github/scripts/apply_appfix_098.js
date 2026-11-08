#!/usr/bin/env node
// [APP-FIX-098] 悬浮窗一直「等待游戏连接」：float.html 里数据源写死 http://127.0.0.1:18766
// （那是 DSH 的端口）→ 永远拿不到 /api/snapshot。改成同源（App 实际绑定的 18764/18772/18773）。
const fs = require('fs');
const H = process.argv[2];
if (!H) throw new Error('usage: apply_appfix_098.js <float.html>');
let h = fs.readFileSync(H, 'utf8');
if (h.includes('[APP-FIX-098]')) { console.log('already applied'); process.exit(0); }
const a = "const BASE='http://127.0.0.1:18766';";
if (!h.includes(a)) throw new Error('anchor missing');
h = h.replace(a, "// [APP-FIX-098] 同源：App 的 HTTP 端口可能不是 18766\nconst BASE=(location&&location.origin&&location.origin!=='null')?location.origin:'http://127.0.0.1:18766';");
fs.writeFileSync(H, h);
console.log('app-fix-098 applied');