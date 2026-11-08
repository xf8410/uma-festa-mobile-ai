#!/usr/bin/env node
// [SKILLTIPS2-3292] 字段名写错：真实字段是 _skillTipsList，不是 skill_tips_array。
const fs=require('fs');
const P=process.argv[2]||'so/hachimi_ura_plugin/src/lib.rs';
let s=fs.readFileSync(P,'utf8');
if(s.includes('[SKILLTIPS2-3292]')){console.log('already applied');process.exit(0);}
const a='read_field_value(chara_class, chara_obj, "skill_tips_array")';
const n=s.split(a).length-1;
if(n!==1) throw new Error('anchor count='+n);
s=s.split(a).join('/* [SKILLTIPS2-3292] 真实字段名 */ read_field_value(chara_class, chara_obj, "_skillTipsList")');
fs.writeFileSync(P,s);
console.log('skilltips2 applied');