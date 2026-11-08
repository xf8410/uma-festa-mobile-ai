#!/usr/bin/env node
// [SCORE-3292] 评价分：五维查定表(EtherealAO/UmaAi) + PT×1.9/2.1，注入 /summary 的 score 字段。
const fs = require('fs');
const https = require('https');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
const MARK = '// [SCORE-3292]';
if (s.includes(MARK)) { console.log('already applied'); process.exit(0); }

function get(u){return new Promise(res=>{const req=https.get(u,{headers:{'User-Agent':'dsh'}},r=>{if(r.statusCode!==200){r.resume();return res('');}const c=[];r.on('data',d=>c.push(d));r.on('end',()=>res(Buffer.concat(c).toString()));});req.on('error',()=>res(''));req.setTimeout(30000,()=>{req.destroy();res('');});});}

(async()=>{
  const src = await get('https://raw.githubusercontent.com/EtherealAO/UmaAi/HEAD/UmaSimulator/GameDatabase/GameConstants.cpp');
  if (!src) throw new Error('fetch GameConstants.cpp failed');
  const i = src.indexOf('FiveStatusFinalScore');
  const a = src.indexOf('{', i), b = src.indexOf('};', a);
  if (i < 0 || a < 0 || b < 0) throw new Error('table not found');
  const nums = (src.slice(a + 1, b).match(/-?\d+/g) || []).map(Number);
  if (nums.length !== 2801) throw new Error('expected 2801 entries, got ' + nums.length);
  console.log('table entries', nums.length, 'max', Math.max(...nums));

  const rows = [];
  for (let k = 0; k < nums.length; k += 20) rows.push('    ' + nums.slice(k, k + 20).join(', ') + ',');
  const TABLE = `${MARK}
/// 五维总和 → 查定分（来源：EtherealAO/UmaAi GameConstants::FiveStatusFinalScore[2801]）
#[rustfmt::skip]
const FIVE_STATUS_FINAL_SCORE: [i32; 2801] = [
${rows.join('\n')}
];

fn five_status_final_score(total: i32) -> i32 {
    if total <= 0 {
        return 0;
    }
    let idx = if total as usize > 2800 { 2800 } else { total as usize };
    FIVE_STATUS_FINAL_SCORE[idx]
}

fn pt_score_value(pt: i32, qiezhe: bool) -> i32 {
    if pt <= 0 {
        return 0;
    }
    let rate = if qiezhe { 2.1_f64 } else { 1.9_f64 };
    (pt as f64 * rate).round() as i32
}

`;
  const anchor = 'unsafe fn read_summary_inner() -> String {';
  const n0 = s.split(anchor).length - 1;
  if (n0 !== 1) throw new Error('anchor count=' + n0);
  s = s.split(anchor).join(TABLE + anchor);

  const injectOld = '    log_predict_step("S:json_done");';
  const n1 = s.split(injectOld).length - 1;
  if (n1 !== 1) throw new Error('inject anchor count=' + n1);
  const injectNew = `    ${MARK} 评价分 = 五维查定 + PT×倍率（技能分待接 mdb）
    {
        let five_total = spd + sta + pow_ + gut + wiz;
        let five_s = five_status_final_score(five_total);
        let pt_s = pt_score_value(spt, false);
        let total_s = five_s + pt_s;
        if let Some(pos) = __out.rfind('}') {
            __out.insert_str(
                pos,
                &format!(
                    ",\\"score\\":{},\\"five_score\\":{},\\"pt_score\\":{},\\"skill_score\\":0",
                    total_s, five_s, pt_s
                ),
            );
        }
    }
    log_predict_step("S:json_done");`;
  s = s.split(injectOld).join(injectNew);

  fs.writeFileSync(P, s);
  console.log('score applied, bytes=' + Buffer.byteLength(s));
})();