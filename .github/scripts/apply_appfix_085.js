#!/usr/bin/env node
// [APP-FIX-085] 引擎二进制找不到（/engine 报 engine_missing）：
// jniLibs 默认走「不压缩、直接从 APK 加载」，nativeLibraryDir 里没有解压出来的文件；
// 我们是用 exec 跑这个二进制（不是 dlopen），所以必须让安装时把它解压出来。
// 用 useLegacyPackaging = true（AGP 8+ 写法）→ nativeLibraryDir/libmatsuri_engine.so 存在且可执行。
const fs = require('fs');
const G = process.argv[2];
if (!G) throw new Error('usage: apply_appfix_085.js <build.gradle.kts>');
let s = fs.readFileSync(G, 'utf8');
if (s.includes('[APP-FIX-085]')) { console.log('already applied'); process.exit(0); }
const anchor = '    compileOptions {';
const n = s.split(anchor).length - 1;
if (n !== 1) throw new Error('anchor count=' + n);
s = s.split(anchor).join(
  '    // [APP-FIX-085] 内置引擎是要 exec 的二进制，必须解压到 nativeLibraryDir\n' +
  '    packaging {\n' +
  '        jniLibs {\n' +
  '            useLegacyPackaging = true\n' +
  '        }\n' +
  '    }\n\n' +
  anchor
);
fs.writeFileSync(G, s);
console.log('app-fix-085 applied');