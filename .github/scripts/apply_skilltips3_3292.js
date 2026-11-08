#!/usr/bin/env node
// [SKILLTIPS3-3292] read_field_value 返回的是「字段地址」不是「引用值」；List 字段要 deref。
// 直接用 read_ptr_at(chara, 696) 取 _skillTipsList 对象。
const fs=require('fs');
const P=process.argv[2]||'so/hachimi_ura_plugin/src/lib.rs';
let s=fs.readFileSync(P,'utf8');
if(s.includes('[SKILLTIPS3-3292]')){console.log('already applied');process.exit(0);}
const a='/* [SKILLTIPS2-3292] 真实字段名 */ read_field_value(chara_class, chara_obj, "_skillTipsList")';
const n=s.split(a).length-1;
if(n!==1) throw new Error('anchor count='+n);
s=s.split(a).join('/* [SKILLTIPS3-3292] 引用字段要 deref，不是取地址 */ read_ptr_at(chara_obj, 696)');
fs.writeFileSync(P,s);
console.log('skilltips3 applied');