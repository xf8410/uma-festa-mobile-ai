#!/usr/bin/env node
// [SKILLNAME-3292] 修技能名映射：text_data 的技能 id 在 [index] 列，不是自增 rowid。
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
const MARK = '// [SKILLNAME-3292]';
if (s.includes(MARK)) { console.log('already applied'); process.exit(0); }

const reps = [
  ['"SELECT id, text FROM text_data WHERE category={}",',
   '"SELECT [index], text FROM text_data WHERE category={} ORDER BY [index]",'],
  ['"SELECT id, text FROM text_data WHERE category={} ORDER BY id",',
   '"SELECT [index], text FROM text_data WHERE category={} ORDER BY [index]",'],
];
let n = 0;
for (const [a, b] of reps) {
  const c = s.split(a).length - 1;
  if (c !== 1) throw new Error(`anchor count=${c}: ${a.slice(0, 50)}`);
  s = s.split(a).join(b);
  n++;
}
s = s.replace('    // Also get skill names', '    ' + MARK + ' 技能名的真实 id 在 [index] 列\n    // Also get skill names');
fs.writeFileSync(P, s);
console.log('skillname fixed, replaced', n, 'queries, bytes=' + Buffer.byteLength(s));