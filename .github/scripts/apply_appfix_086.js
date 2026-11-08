#!/usr/bin/env node
// [ENGINE-ADAPTER] 把适配器接进 EngineBridge：
//  1) 首启解压数据后载入 cardDB（persons.charaId 要用）
//  2) 帧不再写 /summary 原文，改写成引擎帧（FrameAdapter）
//  3) 解析引擎 stdout 的 decision 行 → lastDecision（期望分/σ/档/候选分）
//  4) /engine 里带出 decision
const fs = require('fs');
const P = process.argv[2];
if (!P) throw new Error('usage: apply_appfix_086.js <EngineBridge.kt>');
let s = fs.readFileSync(P, 'utf8');
if (s.includes('[ENGINE-ADAPTER]')) { console.log('already applied'); process.exit(0); }
const once = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error('anchor count=' + n + ' for: ' + JSON.stringify(a.slice(0, 70)));
  s = s.split(a).join(b);
};

// 1) cardDB
once(
  '        copyAssetDir(ctx, "engine/data", dataDir(ctx))',
  '        copyAssetDir(ctx, "engine/data", dataDir(ctx))\n' +
  '        // [ENGINE-ADAPTER] persons.charaId 要查卡册\n' +
  '        FrameAdapter.loadCardDb(File(dataDir(ctx), "cardDB.json"))'
);

// 2) 帧用适配器转换
once(
  '            f.writeText(raw.toString())',
  '            f.writeText(FrameAdapter.toFrame(raw).toString()) // [ENGINE-ADAPTER]'
);

// 3) 决策字段
once(
  '    @Volatile var frames: Int = 0\n        private set',
  '    @Volatile var frames: Int = 0\n        private set\n' +
  '    // [ENGINE-ADAPTER] 最近一条引擎决策（期望分/σ/档/候选分）\n' +
  '    @Volatile var lastDecision: String = ""\n        private set'
);

// 4) stdout 解析
once(
  '        Thread { drain(p.inputStream) { s -> lastLine = s; lines++ } }.start()',
  '        Thread { drain(p.inputStream) { s -> lastLine = s; lines++; onEngineLine(s) } }.start()'
);

// 5) onEngineLine
once(
  '    private fun drain(',
  '    /// [ENGINE-ADAPTER] 解析引擎 stdout 的决策行（type=decision）\n' +
  '    private fun onEngineLine(line: String) {\n' +
  '        try {\n' +
  '            if (!line.contains("type")) return\n' +
  '            val o = org.json.JSONObject(line)\n' +
  '            if (o.optString("type") != "decision") return\n' +
  '            val ex = o.optJSONObject("scenario_extra")\n' +
  '            val d = StringBuilder()\n' +
  '            d.append("{")\n' +
  '            d.append("\\"turn\\":").append(o.optInt("turn", 0)).append(",")\n' +
  '            d.append("\\"score\\":").append(o.optDouble("score", 0.0)).append(",")\n' +
  '            d.append("\\"action_index\\":").append(o.optInt("action_index", 0)).append(",")\n' +
  '            d.append("\\"expected_score\\":").append(ex?.optInt("expected_score", 0) ?: 0).append(",")\n' +
  '            d.append("\\"expected_stdev\\":").append(ex?.optInt("expected_stdev", 0) ?: 0).append(",")\n' +
  '            d.append("\\"expected_rank\\":\\"").append(ex?.optString("expected_rank", "") ?: "").append("\\",")\n' +
  '            d.append("\\"descriptions\\":").append(o.optJSONArray("candidate_descriptions")?.toString() ?: "[]").append(",")\n' +
  '            d.append("\\"scores\\":").append(o.optJSONArray("candidate_scores")?.toString() ?: "[]")\n' +
  '            d.append("}")\n' +
  '            lastDecision = d.toString()\n' +
  '        } catch (e: Throwable) {\n' +
  '        }\n' +
  '    }\n\n' +
  '    private fun drain('
);

// 6) /engine 带上 decision
once(
  '        sb.append("\\"last_error\\":").append(q(trim(lastError)))',
  '        sb.append("\\"last_error\\":").append(q(trim(lastError))).append(",")\n' +
  '        sb.append("\\"decision\\":").append(if (lastDecision.isEmpty()) "null" else lastDecision)'
);

fs.writeFileSync(P, s);
console.log('app-fix-086 applied');