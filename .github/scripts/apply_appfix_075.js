#!/usr/bin/env node
// [APP-FIX-075] 手机 AI 0.7.5：acts 缺失时用 trainings + SO 评分给建议，不再一律「等待游戏连接」
const fs = require('fs');
const H = process.argv[2] || 'app/app/src/main/assets/float.html';
const G = process.argv[3] || 'app/app/build.gradle.kts';
let s = fs.readFileSync(H, 'utf8');
const MARK = '// [APP-FIX-075]';
if (s.includes(MARK)) { console.log('already applied'); process.exit(0); }

const rep = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error(`anchor count=${n}: ${JSON.stringify(a.slice(0, 60))}`);
  s = s.split(a).join(b);
};

// 1) render() 把整帧传给 recommend
rep('  const rec=recommend(acts,trByAttr);',
    '  const rec=recommend(acts,trByAttr,f);');

// 2) recommend() 增加降级分支
rep('function recommend(acts,trByAttr){\n  if(!acts.length)return{txt:\'等待游戏连接\',wait:true};',
`function recommend(acts,trByAttr,f){
  ${MARK} SO 未推 festa.acts 时，用 trainings + SO 的 ai.train 评分兜底
  if(!acts.length){
    const ai=(f&&f.ai)||{};
    const AIKEY={spd:'Speed',sta:'Stamina',pow:'Power',gut:'Guts',wis:'Wisdom'};
    let best=null;
    ((f&&f.trainings)||[]).forEach(t=>{
      const cid=+t.command_id;
      let key=null;
      for(const k in ATTR_CMD){ if(ATTR_CMD[k].indexOf(cid)>=0){key=k;break;} }
      if(!key)return;
      const raw=(ai.train&&ai.train[AIKEY[key]]);
      const score=(typeof raw==='number')?raw:-999;
      const sh=+t.shining||0, heads=+t.heads||0, fail=+t.failure_rate||0;
      const v=score+sh*4+heads*0.5-fail*0.5;
      const attr=(AX.find(a=>a.k===key)||{}).n||key;
      if(!best||v>best.v)best={v,score,sh,attr};
    });
    const rest=(typeof ai.rest==='number')?ai.rest:null;
    if(best&&rest!==null&&rest>best.score+8)
      return{txt:'▶ 休息（AI 休息 '+Math.round(rest)+' > 训练 '+Math.round(best.score)+'）',wait:false};
    if(best&&best.score>-900)
      return{txt:'▶ '+best.attr+'训练（AI '+Math.round(best.score)+(best.sh?' · 彩圈×'+best.sh:'')+'）',wait:false};
    if(best)
      return{txt:'▶ '+best.attr+'训练（彩圈×'+best.sh+'）',wait:false};
    return{txt:'等待游戏连接',wait:true};
  }`);

fs.writeFileSync(H, s);

// 3) 版本号 0.7.5
let g = fs.readFileSync(G, 'utf8');
if (g.includes('versionCode = 16')) {
  g = g.replace('versionCode = 16', 'versionCode = 17')
       .replace('versionName = "0.7.4-festa-compact"', 'versionName = "0.7.5-dsh1"');
  fs.writeFileSync(G, g);
  console.log('version bumped to 0.7.5-dsh1 (17)');
}
console.log('app-fix applied, bytes=' + Buffer.byteLength(s));