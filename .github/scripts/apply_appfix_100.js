#!/usr/bin/env node
// [APP-FIX-100] 人头/角标全部用 SO 真值渲染（对齐 PC panel.rs 呈现口径）：
//   partner_type: 2=Card(白) 1=Friend(绿) 0=Guest/NPC(灰)
//   彩圈：用 SO 的 is_shining（SO 已按引擎规则算：得意训练==当前训练 && 羁绊>=80）
//   叹号：is_tips_event；亮起：is_unique_active；羁绊：current_bond
//   短名：卡/友人用 cardDB 的 short name，NPC 用 [NPC]名
//   不再有任何写死的「担当锁定 / link 卡 / 理事长 / 记者」占位
const fs = require('fs');
const F = process.argv[2];
const I = process.argv[3];
if (!F || !I) throw new Error('usage: apply_appfix_100.js <float.html> <index.html>');
if (fs.readFileSync(I, 'utf8').includes('[APP-FIX-100]')) { console.log('already applied'); process.exit(0); }

// ---- index.html：替换 095 插入的人头渲染块 ----
let idx = fs.readFileSync(I, 'utf8');
const oldStart = idx.indexOf('    // [APP-FIX-095] 人头/角标全部按真实字段渲染');
const oldEndMark = "      heads='<div class=\"v5-head npc\"><span class=\"tx\">本轮无站位</span></div>';\n    }";
const oldEnd = idx.indexOf(oldEndMark, oldStart);
if (oldStart < 0 || oldEnd < 0) throw new Error('index heads block not found');
const newHeads = [
  '    // [APP-FIX-100] 人头/角标用 SO 真值（口径对齐 PC panel.rs）',
  '    const cmdId=5101+idx;',
  '    const tr=(f.trainings||[]).find(function(t){return +t.command_id===cmdId;})||{};',
  '    const ppl=(tr.partners||[]).slice(0,5);',
  '    const badge=function(p){',
  '      let b=\'\';',
  '      if(p.is_shining===true) b+=\'<i class="bg shine" title="彩圈（得意训练+羁绊≥80）">彩</i>\';',
  '      if(p.is_tips_event===true) b+=\'<i class="bg tip" title="叹号 Hint">叹</i>\';',
  '      if(p.is_unique_active===true) b+=\'<i class="bg on" title="亮起（担当锁位）">亮</i>\';',
  '      return b;',
  '    };',
  '    let heads=\'\';',
  '    if(ppl.length){',
  '      heads=ppl.map(function(p){',
  '        const pt=+p.partner_type;',
  '        const typ=(pt===1)?\'guest\':((pt===2)?\'card\':\'npc\');',
  '        let nm=\'\';',
  '        if(pt===2||pt===1){ nm=cardShort(p.support_card_id)||esc(p.name||(\'#\'+p.partner_id)); }',
  '        else { nm=\'[NPC]\'+esc(p.name||(\'#\'+p.partner_id)); }',
  '        const bd=(pt===2&&p.current_bond!=null)?(\' ·\'+p.current_bond):\'\';',
  '        return \'<div class="v5-head \'+typ+\'"><span class="ic"></span><span class="tx">\'+nm+bd+\'</span>\'+badge(p)+\'</div>\';',
  '      }).join(\'\');',
  '    } else {',
  '      heads=\'<div class="v5-head npc"><span class="tx">本轮无站位</span></div>\';',
  '    }'
].join('\n');
idx = idx.slice(0, oldStart) + newHeads + idx.slice(oldEnd + oldEndMark.length);

idx = idx.replace(
  '人头栏：亮起位=固定 link 神驹＋担当卡；<b>理事长 / 记者 / 友人</b>即使无剧本 buff、无稽古角标也保留人头位（SO 未推名单，显示类型标签占位）。',
  '人头栏：站位/羁绊/彩圈/叹号全部按 SO 实时读取；彩圈=得意训练且羁绊≥80（引擎同款规则）。'
);
fs.writeFileSync(I, idx);

// ---- float.html：同样用 SO 的 is_shining ----
let fl = fs.readFileSync(F, 'utf8');
const soCalc = 'const isShiningNow=function(p,cmdIdx){const c=cardMeta(p.support_card_id);if(!c||c.cardType==null)return null;if(p.current_bond==null)return null;const th=(p.bond_threshold==null?80:p.bond_threshold);return (+c.cardType===cmdIdx)&&(+p.current_bond>=+th);};';
if (fl.includes(soCalc)) {
  fl = fl.replace(soCalc, '// [APP-FIX-100] 彩圈直接用 SO 的 is_shining（引擎规则），不再用卡册推算\nconst isShiningNow=function(p){return p&&p.is_shining===true;};');
}
fs.writeFileSync(F, fl);

console.log('app-fix-100 applied');