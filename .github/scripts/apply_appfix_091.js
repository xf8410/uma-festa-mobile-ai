#!/usr/bin/env node
// [APP-FIX-091] festa.kensan：用 SO 已经读到的 ActTrainingState（acts[].state）推「稽古已掷中」标记
// 上游帧字段 festa.kensan = [bool;5]（matsuri-core Restore 里按它决定是否可追加稽古）
// 口径：state != 0 视为该演目本回合已可追加稽古；长度不是 5 时写 null 并在 _adapter_notes 标注
const fs = require('fs');
const P = process.argv[2];
if (!P) throw new Error('usage: apply_appfix_091.js <FrameAdapter.kt>');
let s = fs.readFileSync(P, 'utf8');
if (s.includes('[APP-FIX-091]')) { console.log('already applied'); process.exit(0); }
const anchor = '        val festa = JSONObject().apply {';
if (!s.includes(anchor)) throw new Error('anchor missing');
const add = [
'        // [APP-FIX-091] 稽古掷中标记：acts[].state（SO 的 ActTrainingState）非 0 视为已掷中',
'        val kensanArr = JSONArray()',
'        for (i in 0 until fa.length()) {',
'            val a = fa.optJSONObject(i) ?: continue',
'            kensanArr.put(a.optInt("state", 0) != 0)',
'        }',
'        if (kensanArr.length() != 5) notes.put("kensan_missing_or_partial")',
'        val festa = JSONObject().apply {',
].join('\n');
s = s.replace(anchor, add);
const anchor2 = '            put("kensan", JSONObject.NULL)';
if (s.includes(anchor2)) {
  s = s.split(anchor2).join('            put("kensan", if (kensanArr.length() == 5) kensanArr else JSONObject.NULL) // [APP-FIX-091]');
} else {
  console.log('warn: kensan slot not found (skipped value)');
}
fs.writeFileSync(P, s);
console.log('app-fix-091 applied');