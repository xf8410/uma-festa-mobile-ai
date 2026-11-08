#!/usr/bin/env node
// [APP-FIX-099] 人头/角标补真值（不依赖 SO 的 is_shining，因为它读不到支援卡得意训练）：
//  1) 新增接口 /api/carddb → 直接吐 assets/engine/data/cardDB.json
//  2) float.html / index.html 取 cardDB：cardType 0=速 1=耐 2=力 3=根 4=智（实测 [根]特别周 cardType=3）
//     彩圈 = 该卡得意训练 == 当前训练位 && current_bond >= bond_threshold（上游规则）
//     人头标签用卡名（cardName）代替「支援位N」
const fs = require('fs');
const K = process.argv[2];
const F = process.argv[3];
const I = process.argv[4];
if (!K || !F || !I) throw new Error('usage: apply_appfix_099.js <NativeEngine.kt> <float.html> <index.html>');
let k = fs.readFileSync(K, 'utf8');
let f = fs.readFileSync(F, 'utf8');
let i = fs.readFileSync(I, 'utf8');
if (k.includes('[APP-FIX-099]')) { console.log('already applied'); process.exit(0); }
const once = (src, a, b, tag) => {
  const c = src.split(a).length - 1;
  if (c !== 1) { console.log('skip(' + (tag || '') + ' count=' + c + '): ' + JSON.stringify(a.slice(0, 44))); return src; }
  return src.split(a).join(b);
};

// 1) 路由
k = once(k,
  '            p == "/float" || p == "/float.html" -> asset("float.html", "text/html; charset=utf-8")',
  '            p == "/float" || p == "/float.html" -> asset("float.html", "text/html; charset=utf-8")\n' +
  '            // [APP-FIX-099] 卡册（支援卡名 / 得意训练），人头角标在页面侧按上游规则算\n' +
  '            p == "/api/carddb" -> asset("engine/data/cardDB.json", "application/json")'
);

const FX = [
  "// [APP-FIX-099] 卡册：支援卡名 / 得意训练（cardType 0速1耐2力3根4智）",
  "let CARDD={};",
  "fetch(BASE+'/api/carddb',{cache:'force-cache'}).then(function(r){return r.json();}).then(function(j){CARDD=j;}).catch(function(){});",
  "const cardMeta=function(id){return CARDD[String(id)]||null;};",
  "const cardShort=function(id){const c=cardMeta(id);if(!c)return '';const n=String(c.cardName||'');const m=n.match(/^\\[([^\\]]+)\\]/);return m?m[1]+' '+n.replace(/^\\[[^\\]]+\\]/,''):n;};",
  "const isShiningNow=function(p,cmdIdx){const c=cardMeta(p.support_card_id);if(!c||c.cardType==null)return null;if(p.current_bond==null)return null;const th=(p.bond_threshold==null?80:p.bond_threshold);return (+c.cardType===cmdIdx)&&(+p.current_bond>=+th);};"
].join('\n');

f = once(f,
  "const advName=id=>ADV[+id]||(+id>0?'#'+id:'—');",
  "const advName=id=>ADV[+id]||(+id>0?'#'+id:'—');\n" + FX,
  'float'
);
i = once(i,
  "const V5_KEYS=['spd','sta','pow','gut','wis'];",
  "const V5_KEYS=['spd','sta','pow','gut','wis'];\n" + FX,
  'index'
);

fs.writeFileSync(K, k);
fs.writeFileSync(F, f);
fs.writeFileSync(I, i);
console.log('app-fix-099 applied');