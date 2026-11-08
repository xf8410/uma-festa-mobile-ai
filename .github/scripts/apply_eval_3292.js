#!/usr/bin/env node
// [EVAL-3292] 官方评价分直接读游戏自己的：Gallop.WorkSingleModeCharaData.GetEvaluation()（0 参）
//   之前我们用「五维总和查表 + PT×1.9」近似，和官方口径不一致（官方=逐维 StatusToPoint + 技能分）。
//   现在 /summary 多一个 "evaluation"（游戏真值；读不到给 -1），App 优先显示它。
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
if (s.includes('[EVAL-3292]')) { console.log('already applied'); process.exit(0); }
const anchor = '    // [SCORE-3292] 评价分 = 五维查定 + PT×倍率（技能分待接 mdb）';
if (!s.includes(anchor)) throw new Error('score anchor missing');
const pre = [
  '    // [EVAL-3292] 官方评价分：游戏自己的 GetEvaluation()（0 参、只读计算）',
  '    //   读不到 / 越界时给 -1，App 退回自算值',
  '    let evaluation: i32 = {',
  '        let v = call_getter_int(chara_class, chara_obj, "GetEvaluation");',
  '        if v > 0 && v < 500000 { v } else { -1 }',
  '    };',
].join('\n');
s = s.replace(anchor, pre + '\n' + anchor);
const fmtOld = '",\\"score\\":{},\\"five_score\\":{},\\"pt_score\\":{},\\"skill_score\\":0"';
if (s.includes(fmtOld)) {
  s = s.replace(fmtOld, '",\\"score\\":{},\\"five_score\\":{},\\"pt_score\\":{},\\"skill_score\\":0,\\"evaluation\\":{}"');
} else {
  s = s.replace('\\"skill_score\\":0"', '\\"skill_score\\":0,\\"evaluation\\":{}"');
}
const argOld = '                    total_s, five_s, pt_s\n';
if (s.includes(argOld)) {
  s = s.split(argOld).join('                    total_s, five_s, pt_s, evaluation\n');
} else {
  console.log('warn: score arg anchor missing');
}
fs.writeFileSync(P, s);
console.log('eval patch applied');