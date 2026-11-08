#!/usr/bin/env node
// [APP-FIX-084] 白屏修复：18766 被 DSH 之类占用时，App 实际绑的是 18764，
// 但 MainActivity/悬浮窗还写死去加载 http://127.0.0.1:18766/ → 加载到别人的服务
// （表现就是白屏 + 一行 {"ok":false,"error":"unknown path"}）。
// 改法：加载 URL 用「实际绑定端口」NativeEngine.boundPort（0 时退回 18766）。
// 注意：主面板路径是 "/"，悬浮窗页面是 "/float"（基线里 FLOAT_URL 就是这么写的）。
const fs = require('fs');
const M = process.argv[2];
const F = process.argv[3];
if (!M || !F) throw new Error('usage: apply_appfix_084.js <MainActivity.kt> <FloatingWindowService.kt>');
let m = fs.readFileSync(M, 'utf8');
let f = fs.readFileSync(F, 'utf8');
if (m.includes('[APP-FIX-084]')) { console.log('already applied'); process.exit(0); }
const once = (src, a, b) => {
  const n = src.split(a).length - 1;
  if (n !== 1) throw new Error('anchor count=' + n + ' for: ' + JSON.stringify(a.slice(0, 70)));
  return src.split(a).join(b);
};

// 1) MainActivity：入口两处（首次 + 重试）改用实际端口
const loadOld = 'if (NativeEngine.start(BIND, dir, this) || portAlreadyServed()) web.loadUrl(LOCAL)';
const cnt = m.split(loadOld).length - 1;
if (cnt !== 2) throw new Error('main load anchor count=' + cnt);
m = m.split(loadOld).join('if (NativeEngine.start(BIND, dir, this) || portAlreadyServed()) web.loadUrl(baseUrlOf())');

// 2) MainActivity：加 baseUrlOf()
m = once(
  m,
  '    /** 端口被上一进程占住时，先确认它确实是自己的接收端，是则同源加载，不退回 file:// */',
  '    // [APP-FIX-084] 18766 可能被别的进程占（本机 DSH 等），加载用实际绑定端口，否则会白屏\n' +
  '    private fun baseUrlOf(): String {\n' +
  '        val p = NativeEngine.boundPort\n' +
  '        return "http://127.0.0.1:" + (if (p > 0) p else 18766) + "/"\n' +
  '    }\n\n' +
  '    /** 端口被上一进程占住时，先确认它确实是自己的接收端，是则同源加载，不退回 file:// */'
);

// 3) 悬浮窗：同样走实际端口（页面路径 /float）
const wOld = 'web?.loadUrl(FLOAT_URL)';
const wCnt = f.split(wOld).length - 1;
if (wCnt !== 2) throw new Error('float load anchor count=' + wCnt);
f = f.split(wOld).join('web?.loadUrl(floatUrlOf())');
f = once(
  f,
  '        private val SCALES = floatArrayOf(1.0f, 0.70f, 0.45f)',
  '        // [APP-FIX-084] 实际绑定端口（18766 被占时是 18764）\n' +
  '        private fun floatUrlOf(): String {\n' +
  '            val p = NativeEngine.boundPort\n' +
  '            return "http://127.0.0.1:" + (if (p > 0) p else 18766) + "/float"\n' +
  '        }\n' +
  '        private val SCALES = floatArrayOf(1.0f, 0.70f, 0.45f)'
);

fs.writeFileSync(M, m);
fs.writeFileSync(F, f);
console.log('app-fix-084 applied');