#!/usr/bin/env node
// [ENGINE-ANDROID] 把上游 umaai 引擎接进 App：启动子进程 + 每帧落盘 + 诊断端点 /engine
//   - 引擎二进制 libmatsuri_engine.so 由 workflow 放进 jniLibs/arm64-v8a（Android 10+ 只有
//     nativeLibraryDir 里的文件可执行）
//   - 引擎数据 data/*.json 由 workflow 放进 assets/engine/data，首启解压到 filesDir/engine/data
//   - 模拟/蒙特卡洛全在 App 进程跑，绝不进游戏进程（SO 只读内存推帧）
const fs = require('fs');
const P = process.argv[2];
if (!P) throw new Error('usage: apply_appfix_082.js <NativeEngine.kt>');
let s = fs.readFileSync(P, 'utf8');
if (s.includes('[ENGINE-ANDROID]')) { console.log('already applied'); process.exit(0); }
const once = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error('anchor count=' + n + ' for: ' + JSON.stringify(a.slice(0, 60)));
  s = s.split(a).join(b);
};

// 1) start() 里初始化引擎
once(
  '        if (ctx != null) appContext = ctx.applicationContext',
  '        if (ctx != null) appContext = ctx.applicationContext\n' +
  '        // [ENGINE-ANDROID] 拉起内置 umaai 引擎（App 进程内，别放游戏里算）\n' +
  '        if (ctx != null) EngineBridge.init(ctx.applicationContext)'
);

// 2) 每帧喂给引擎
once(
  '        val raw = try { JSONObject(body) } catch (ignored: Exception) { return }',
  '        val raw = try { JSONObject(body) } catch (ignored: Exception) { return }\n' +
  '        // [ENGINE-ANDROID] 落一份帧文件给内置引擎\n' +
  '        appContext?.let { EngineBridge.onSummary(it, raw) }'
);

// 3) 诊断端点 /engine
once(
  '            p == "/api/health" -> json(healthJson().toString())',
  '            p == "/engine" -> json(EngineBridge.statusJson()) // [ENGINE-ANDROID]\n' +
  '            p == "/api/health" -> json(healthJson().toString())'
);

fs.writeFileSync(P, s);
console.log('app-fix-082 applied');