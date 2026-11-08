#!/usr/bin/env node
// [APP-FIX-081] 把「期望分（运气投影）+ 评级」接到 App 面板，口径照抄上游 umaai 4bc0e653：
//   上游终端一行：`[回合 32 运气]本局：+150, 本轮: +150, 期望 82140 （±3012，LF）`
//   - 期望 = expected_score + (MAX_TURN(77) − 已过回合) × luck_turn_bonus(100)
//   - 评级 = 用**投影后的分**查 rank 表（上游就是在投影后重新 get_rank_name，老版本漏了这步才显示错档）
//   手机端没有蒙特卡洛 σ，所以不显示 ±σ；rank 表取上游 data/constants.json（298 档，G…LS24）。
const fs = require('fs');
const path = require('path');
const N = process.argv[2];
const H = process.argv[3];
const G = process.argv[4];
if (!H) throw new Error('usage: apply_appfix_081.js <NativeEngine.kt> <index.html> <build.gradle.kts>');
let h = fs.readFileSync(H, 'utf8');
if (h.includes('[APP-FIX-081]')) { console.log('already applied'); process.exit(0); }
const tbl = JSON.parse(fs.readFileSync(path.join(__dirname, 'rank_table.json'), 'utf8'));
const RS = '[' + tbl.rank_scores.join(',') + ']';
const RN = '[' + tbl.rank_names.map(function (s) { return JSON.stringify(s); }).join(',') + ']';
const anchor = "  document.getElementById('f-score').textContent=f?n(f.score):'—';";
const c = h.split(anchor).length - 1;
if (c !== 1) throw new Error('html anchor count=' + c);
const js = [
  "  // [APP-FIX-081] 期望分/运气投影 + 评级（口径照抄上游 umaai 4bc0e653 projected_summary）",
  "  try{",
  "    if(f){",
  "      const RS=" + RS + ";",
  "      const RN=" + RN + ";",
  "      const BONUS=100, MAXT=77;",
  "      const mon=n(f.month)||1, half=n(f.half)||1;",
  "      let el=(mon-1)*2+(half-1); if(el<0)el=0; if(el>MAXT)el=MAXT;",
  "      const luck=(MAXT-el)*BONUS;",
  "      const base=n(f.score)||0;",
  "      const exp=base+luck;",
  "      let rank='';",
  "      if(RN.length){",
  "        let lo=0,hi=RS.length-1,idx=0; const sc=Math.round(exp);",
  "        while(lo<=hi){const mid=(lo+hi)>>1; if(RS[mid]<=sc){idx=mid;lo=mid+1;} else {hi=mid-1;}}",
  "        rank=RN[idx];",
  "      }",
  "      const cell=document.getElementById('f-score')&&document.getElementById('f-score').parentElement;",
  "      if(cell){",
  "        let nt=cell.querySelector('.lucknote');",
  "        if(!nt){nt=document.createElement('span');nt.className='lucknote';nt.style.cssText='display:block;font-size:9px;line-height:1.15;color:#b9c6bf;margin-top:1px;white-space:nowrap;';cell.appendChild(nt);}",
  "        nt.textContent='期望 '+fmt(exp)+(rank?(' '+rank):'')+' · 运气+'+fmt(luck);",
  "      }",
  "    }",
  "  }catch(e){}",
].join('\n');
h = h.replace(anchor, anchor + '\n' + js);
fs.writeFileSync(H, h);
if (G && fs.existsSync(G)) {
  let g = fs.readFileSync(G, 'utf8');
  g = g.replace(/versionCode = \d+/, 'versionCode = 26')
       .replace(/versionName = "[^"]*"/, 'versionName = "0.9.1-dsh10"');
  fs.writeFileSync(G, g);
}
console.log('app-fix-081 applied');