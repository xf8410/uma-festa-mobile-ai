#!/usr/bin/env node
// [APP-FIX-081] 运气分/本局分/期望分/评级 —— 口径逐行照抄上游 umaai（record.rs + luck.rs + output.rs）：
//   显示分  disp(raw, turn) = raw + (MAX_TURN(77) − turn) × luck_turn_bonus(100)
//   初始基线 init = raw(T1) + MAX_TURN × bonus            （上游恒按 turn=0 换算）
//   本局运气 total = disp(now) − init                      （上游 LuckScoreTracker.total_luck_score）
//   本轮运气 delta = disp(now) − disp(prev)                （上游 last_turn_delta）
//   期望分 = disp(now)；评级 = 用**投影后**的分查 rank 表（上游 projected_summary 会重算 rank）
//   切局：chara_id 变化或回合回退 → 重置跟踪器
//   手机端暂时没有蒙特卡洛，所以 ±σ 不显示（上游 σ=0 时同样整段不显示）
//   rank 表来自上游 data/constants.json（298 档，G…LS24），CI 内按 commit 固定抓取
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
  "  // [APP-FIX-081] 运气分/本局分/期望分/评级（口径照抄上游 umaai record.rs/luck.rs/output.rs）",
  "  try{",
  "    if(f){",
  "      const RS=" + RS + ";",
  "      const RN=" + RN + ";",
  "      const BONUS=100, MAXT=77;",
  "      const mon=n(f.month)||1, half=n(f.half)||1;",
  "      let t=(mon-1)*2+(half-1); if(t<0)t=0; if(t>MAXT)t=MAXT;",
  "      const raw=n(f.score)||0;",
  "      const disp=raw+(MAXT-t)*BONUS;",
  "      const epoch=String(n(f.chara_id)||0);",
  "      let L=window.__luck;",
  "      if(!L||L.epoch!==epoch||t<L.turn){",
  "        L={epoch:epoch,turn:t,init:raw+MAXT*BONUS,last:disp,total:0,delta:null};",
  "        window.__luck=L;",
  "      } else if(t>L.turn){",
  "        L.delta=disp-L.last; L.total=disp-L.init; L.last=disp; L.turn=t;",
  "      } else {",
  "        L.last=disp; L.total=disp-L.init;",
  "      }",
  "      let rank='';",
  "      if(RN.length){",
  "        let lo=0,hi=RS.length-1,idx=0; const sc=Math.round(disp);",
  "        while(lo<=hi){const mid=(lo+hi)>>1; if(RS[mid]<=sc){idx=mid;lo=mid+1;} else {hi=mid-1;}}",
  "        rank=RN[idx];",
  "      }",
  "      const cell=document.getElementById('f-score')&&document.getElementById('f-score').parentElement;",
  "      if(cell){",
  "        let nt=cell.querySelector('.lucknote');",
  "        if(!nt){nt=document.createElement('span');nt.className='lucknote';nt.style.cssText='display:block;font-size:9px;line-height:1.12;color:#b9c6bf;margin-top:1px;';cell.appendChild(nt);}",
  "        const sg=function(v){return (v>=0?'+':'')+Math.round(v);};",
  "        nt.innerHTML='期望 '+fmt(disp)+(rank?(' <b style=\"color:#d8f0dd\">'+rank+'</b>'):'')+",
  "          '<br>本局 '+sg(L.total)+' · 本轮 '+(L.delta===null?'--':sg(L.delta));",
  "      }",
  "    }",
  "  }catch(e){}",
].join('\n');
h = h.replace(anchor, anchor + '\n' + js);
fs.writeFileSync(H, h);
if (G && fs.existsSync(G)) {
  let g = fs.readFileSync(G, 'utf8');
  g = g.replace(/versionCode = \d+/, 'versionCode = 27')
       .replace(/versionName = "[^"]*"/, 'versionName = "0.9.2-dsh11"');
  fs.writeFileSync(G, g);
}
console.log('app-fix-081 applied (v0.9.2-dsh11)');