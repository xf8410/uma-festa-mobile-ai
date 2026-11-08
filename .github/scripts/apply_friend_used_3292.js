#!/usr/bin/env node
// [FRIEND-USED-3292] friend_outgoing_used 读不到时不要写 -1（会被当"未知"传进帧）：
//   GuestOutingInfoList 为空 = 本局还没出行过 → 0；
//   列表读到但没有友人卡条目 → 0；
//   只有列表读失败（指针空）才保留 -1 表示未知。
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
if (s.includes('[FRIEND-USED-3292]')) { console.log('already applied'); process.exit(0); }
const a = '        let mut friend_used = -1i32;';
if (!s.includes(a)) throw new Error('anchor missing');
s = s.split(a).join('        // [FRIEND-USED-3292] 默认 0（没出行过），只有列表读失败才留 -1\n        let mut friend_used = 0i32;');
const b = '            let g_list = read_field_value(chara_class, chara_obj, "GuestOutingInfoList");\n            for e in walk_obj_list(g_list) {';
if (s.includes(b)) {
  s = s.split(b).join('            let g_list = read_field_value(chara_class, chara_obj, "GuestOutingInfoList");\n            if g_list.is_null() { friend_used = -1; }\n            for e in walk_obj_list(g_list) {');
}
fs.writeFileSync(P, s);
console.log('friend-used patch applied');