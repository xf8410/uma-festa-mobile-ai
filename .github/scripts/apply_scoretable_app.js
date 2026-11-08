#!/usr/bin/env node
// [APP-SCORETABLE] 把五维查定表内置进 App（Kotlin），由 App 自己算评价分。
const fs=require('fs'), https=require('https');
const DIR=process.argv[2]||'app/app/src/main/java/com/ranko/matsuricapture';
const NE=DIR+'/NativeEngine.kt';

function get(u){return new Promise(res=>{const req=https.get(u,{headers:{'User-Agent':'dsh'}},r=>{if(r.statusCode!==200){r.resume();return res('');}const c=[];r.on('data',d=>c.push(d));r.on('end',()=>res(Buffer.concat(c).toString()));});req.on('error',()=>res(''));req.setTimeout(30000,()=>{req.destroy();res('');});});}

(async()=>{
  if(fs.existsSync(DIR+'/ScoreTable.kt')){console.log('already applied');process.exit(0);}
  const src=await get('https://raw.githubusercontent.com/EtherealAO/UmaAi/HEAD/UmaSimulator/GameDatabase/GameConstants.cpp');
  if(!src) throw new Error('fetch table failed');
  const i=src.indexOf('FiveStatusFinalScore');
  const a=src.indexOf('{',i), b=src.indexOf('};',a);
  const nums=(src.slice(a+1,b).match(/-?\d+/g)||[]).map(Number);
  if(nums.length!==2801) throw new Error('table size '+nums.length);
  const rows=[];
  for(let k=0;k<nums.length;k+=25) rows.push('        '+nums.slice(k,k+25).join(', ')+',');
  const KT=`package com.ranko.matsuricapture

// [APP-SCORETABLE] 五维查定表内置（来源：EtherealAO/UmaAi GameConstants::FiveStatusFinalScore[2801]）
object ScoreTable {
    const val PT_RATE = 1.9
    const val PT_RATE_QIEZHE = 2.1

    private val FIVE = intArrayOf(
${rows.join('\n')}
    )

    fun fiveScore(total: Int): Int {
        if (total <= 0) return 0
        return FIVE[if (total > 2800) 2800 else total]
    }

    fun ptScore(pt: Int, qiezhe: Boolean): Int {
        if (pt <= 0) return 0
        val r = if (qiezhe) PT_RATE_QIEZHE else PT_RATE
        return Math.round(pt * r).toInt()
    }

    fun total(five: IntArray, pt: Int, skillScore: Int, qiezhe: Boolean): Int =
        fiveScore(five.sum()) + ptScore(pt, qiezhe) + skillScore
}
`;
  fs.writeFileSync(DIR+'/ScoreTable.kt',KT);
  console.log('wrote ScoreTable.kt',KT.length,'bytes');

  let n=fs.readFileSync(NE,'utf8');
  if(!n.includes('[APP-SCORETABLE]')){
    const anchor='            .put("raw", summary)';
    const c=n.split(anchor).length-1;
    if(c!==1) throw new Error('anchor count='+c);
    n=n.split(anchor).join(`            // [APP-SCORETABLE] App 自己算评价分（不依赖 SO 的 score）
            .put("score", localScore(summary, stats))
${anchor}`);
    const anchor2='    private fun normalize(';
    const fn=`    // [APP-SCORETABLE] 内置表算分：五维查定 + PT×倍率 + 技能分（技能分暂 0）
    private fun localScore(summary: JSONObject, stats: JSONObject?): Int {
        if (stats == null) return -1
        val five = IntArray(5) { iv(stats, FIVE_KEYS[it]).toInt().coerceAtLeast(0) }
        val pt = iv(stats, "skill_point").toInt().coerceAtLeast(0)
        val skill = iv(summary, "skill_score").toInt().coerceAtLeast(0)
        val qie = summary.optBoolean("is_qie_zhe", false)
        return ScoreTable.total(five, pt, skill, qie)
    }

`;
    const c2=n.split(anchor2).length-1;
    if(c2!==1) throw new Error('normalize anchor count='+c2);
    n=n.split(anchor2).join(fn+anchor2);
    fs.writeFileSync(NE,n);
    console.log('patched NativeEngine.kt');
  }
})();