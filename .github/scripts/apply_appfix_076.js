#!/usr/bin/env node
// [APP-FIX-076] 撤掉 0.7.5 的"无 acts 也给训练建议"降级（那是编的），改成如实缺数据提示。
const fs = require('fs');
const H = process.argv[2] || 'app/app/src/main/assets/float.html';
const G = process.argv[3] || 'app/app/build.gradle.kts';
let s = fs.readFileSync(H, 'utf8');
if (s.includes('// [APP-FIX-076]')) { console.log('already applied'); process.exit(0); }

const START = '  // [APP-FIX-075] SO 未推 festa.acts 时，用 trainings + SO 的 ai.train 评分兜底';
const END = "    return{txt:'等待游戏连接',wait:true};\n  }";
const i0 = s.indexOf(START);
if (i0 < 0) throw new Error('075 fallback block not found');
const i1 = s.indexOf(END, i0);
if (i1 < 0) throw new Error('075 fallback end not found');

const NEW = `  // [APP-FIX-076] 祭典杯的最优训练取决于演目/稽古槽，SO 没推 festa.acts 就无从计算——
  // 这里如实报告缺数据，不再用 trainings 的彩圈瞎推荐（0.7.5 那版是错的）。
  if(!acts.length){
    const miss=(f&&f.missing)||[];
    if(f&&f.has_festa===false)
      return{txt:'缺 festa 数据 · SO 未推 acts',wait:true};
    if(miss.indexOf('festa')>=0)
      return{txt:'缺 festa 数据 · 剧本 15 未识别',wait:true};
    return{txt:'等待游戏连接',wait:true};
  }`;
s = s.slice(0, i0) + NEW + s.slice(i1 + END.length);

// 版本 0.7.6 / 18
let g = fs.readFileSync(G, 'utf8');
g = g.replace(/versionCode = \d+/, 'versionCode = 18')
     .replace(/versionName = "[^"]*"/, 'versionName = "0.7.6-dsh1"');
fs.writeFileSync(G, g);
fs.writeFileSync(H, s);
console.log('app-fix-076 applied, bytes=' + Buffer.byteLength(s));