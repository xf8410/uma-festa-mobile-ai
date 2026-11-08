#!/usr/bin/env node
// [APP-FIX-079] 一屏版密度优化：建议页不滚动、信息一屏看完；buff 区保留（不得按空隐藏）。
const fs = require('fs');
const H = process.argv[2] || 'app/app/src/main/assets/index.html';
const K = process.argv[3] || 'app/app/src/main/java/com/ranko/matsuricapture/FloatingWindowService.kt';
const G = process.argv[4] || 'app/app/build.gradle.kts';
let s = fs.readFileSync(H, 'utf8');
if (s.includes('[APP-FIX-079]')) { console.log('already applied'); process.exit(0); }
const rep = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error(`anchor count=${n}: ${JSON.stringify(a.slice(0, 50))}`);
  s = s.split(a).join(b);
};

// 1) 演目态势两行合并成一行
rep(`        <div class="row"><span class="k">本局演目达成</span><span class="v" id="a-progress">—</span></div>
        <div class="row"><span class="k">本回合槽增</span><span class="v" id="a-gain">—</span></div>`,
`        <div class="row"><span class="k">演目</span><span class="v"><span id="a-progress">—</span> · <span id="a-gain">—</span></span></div>`);

// 2) 建议页一屏布局 CSS
rep(`.v5-rule .rr{text-align:center;color:var(--dim)}

</style>`,
`.v5-rule .rr{text-align:center;color:var(--dim)}

/* [APP-FIX-079] 一屏密度：建议页不滚动 */
#page-advice{display:flex;flex-direction:column;gap:6px;overflow:hidden;padding-bottom:2px}
#page-advice .card{padding:7px 9px;border-radius:10px;margin:0}
#page-advice .card h2{font-size:11.5px;margin:0 0 3px}
#page-advice .app-title{font-size:11px;margin:0}
#page-advice .eyebrow{margin:0;font-size:9.5px}
#page-advice h1.big{font-size:19px;line-height:1.15;margin:0}
#page-advice p.sub{margin:0;font-size:9.5px;line-height:1.3}
#page-advice .row{padding:1px 0;font-size:11px}
#page-advice .hint{font-size:9px;line-height:1.25;margin-top:2px}
#page-advice .btn.small{padding:4px 6px;font-size:10px}
#page-advice .five .cell{padding:2px 1px}
#page-advice .flist .act{padding:2px 2px;gap:3px}
#page-advice .flist .act .nm{width:52px}
#page-advice .flist .act .nm b{font-size:11.5px}
#page-advice .flist .act .ad,#page-advice .flist .act .flag{display:none}
#page-advice .flist .act .lv{width:30px;font-size:9.5px}
#page-advice .uicols{display:grid;grid-template-columns:62% 38%;gap:6px;align-items:start}
</style>`);

// 3) 左右两栏：左=态势/稽古/数值，右=演目
rep(`      <div class="card">
        <h2>演目态势 <span class="badge">FESTA</span></h2>`,
`      <div class="uicols"><div class="uicol-l">
      <div class="card">
        <h2>演目态势 <span class="badge">FESTA</span></h2>`);

rep(`      <div class="card">
        <h2>祭典杯 · 演目 <span class="badge">5 演目</span></h2>`,
`      </div><div class="uicol-r">
      <div class="card">
        <h2>祭典杯 · 演目 <span class="badge">5 演目</span></h2>`);

rep(`      <!-- v0.5.0 教诲 buff 全表：5 基础 + 5 进化 -->
      <div class="card">`,
`      </div></div><!-- /uicols -->
      <!-- v0.5.0 教诲 buff 全表（buff 每回合分配到属性支援卡/NPC，保留） -->
      <div class="card">`);

fs.writeFileSync(H, s);

// 4) 大屏高度 60% → 78%
let k = fs.readFileSync(K, 'utf8');
k = k.split('wlp.height = (0.60 * resources.displayMetrics.heightPixels).toInt()').join('wlp.height = (0.78 * resources.displayMetrics.heightPixels).toInt()');
k = k.split('val bigH = (0.60 * resources.displayMetrics.heightPixels).toInt()').join('val bigH = (0.78 * resources.displayMetrics.heightPixels).toInt() // [APP-FIX-079] 一屏');
fs.writeFileSync(K, k);

let g = fs.readFileSync(G, 'utf8');
g = g.replace(/versionCode = \d+/, 'versionCode = 21')
     .replace(/versionName = "[^"]*"/, 'versionName = "0.7.9-dsh4"');
fs.writeFileSync(G, g);
console.log('app-fix-079 applied, bytes=' + Buffer.byteLength(s));