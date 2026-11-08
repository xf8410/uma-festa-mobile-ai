#!/usr/bin/env node
// [SKILLHOOK2-3292] 修编译错误 E0133：两个 hook 回调里 `let ret = original(this);`
// 直接调用 unsafe fn，需要包 unsafe 块。
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
const MARK = '// [SKILLHOOK2-3292]';
if (s.includes(MARK)) { console.log('already applied'); process.exit(0); }
const A = '    let ret = original(this);';
const n = s.split(A).length - 1;
if (n !== 2) throw new Error('anchor count=' + n);
s = s.split(A).join(`${MARK} original 是 unsafe fn，必须显式 unsafe 块\n    let ret = unsafe { original(this) };`);
fs.writeFileSync(P, s);
console.log('skillhook2 applied');