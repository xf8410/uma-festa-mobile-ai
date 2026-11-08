#!/usr/bin/env node
// [APP-FIX-096] 两处接线 bug：
//  1) EngineBridge：插件目录必须在起进程**之前**建好（上游 FileChannel::open 要求目录已存在），
//     否则引擎秒退「小黑板数据目录不存在」。原来只在 onSummary 里 mkdirs，太晚。
//  2) NativeEngine.pullLoop：主动拉取那条路只 store() 没喂引擎 → 引擎永远收不到帧（frames 恒 0）。
//     拉到的 /summary 也要 EngineBridge.onSummary。
const fs = require('fs');
const K = process.argv[2];
const N = process.argv[3];
if (!K || !N) throw new Error('usage: apply_appfix_096.js <EngineBridge.kt> <NativeEngine.kt>');
let k = fs.readFileSync(K, 'utf8');
let n = fs.readFileSync(N, 'utf8');
if (k.includes('[APP-FIX-096]')) { console.log('already applied'); process.exit(0); }
const once = (src, a, b) => {
  const c = src.split(a).length - 1;
  if (c !== 1) { console.log('skip(count=' + c + '): ' + JSON.stringify(a.slice(0, 50))); return src; }
  return src.split(a).join(b);
};

// 1) 起进程前建插件目录
k = once(
  k,
  '        startOne(ctx, engine, "matsuri")\n        startOne(ctx, engine, "search")',
  '        // [APP-FIX-096] 上游 FileChannel 要求插件目录先存在，否则直接报错退出\n' +
  '        pluginDir(ctx, "matsuri")\n' +
  '        pluginDir(ctx, "search")\n' +
  '        startOne(ctx, engine, "matsuri")\n' +
  '        startOne(ctx, engine, "search")'
);

// 2) 拉取链路也喂引擎
n = once(
  n,
  '                            lastSummaryError = ""\n                            store(normalize(jo, null, "pull"))',
  '                            lastSummaryError = ""\n' +
  '                            // [APP-FIX-096] 主动拉取这条线也要喂内置引擎（原来只 store，引擎收不到帧）\n' +
  '                            appContext?.let { EngineBridge.onSummary(it, jo) }\n' +
  '                            store(normalize(jo, null, "pull"))'
);

fs.writeFileSync(K, k);
fs.writeFileSync(N, n);
console.log('app-fix-096 applied');