#!/usr/bin/env node
// [ENGINE-JSON-VIEW] 决策 JSON 带上引擎的完整回合快照 view（MatsuriView）：
//   盘面（人头/彩圈/演目槽）、资源、数值、赛程（目标赛/自选赛）、友人、合宿——PC 面板的单一数据源。
//   手机端从此按 view 渲染，不再自己算盘面（SO 只负责读内存出原始帧）。
const fs = require('fs');
const P = process.argv[2];
if (!P) throw new Error('usage: apply_engine_json_view.js <crates/matsuri-ai/src/output.rs>');
let s = fs.readFileSync(P, 'utf8');
if (s.includes('[ENGINE-JSON-VIEW]')) { console.log('already applied'); process.exit(0); }
const anchor = `                    "candidate_n": candidate_n,
                    "scenario_extra": extra,`;
if (!s.includes(anchor)) throw new Error('json anchor missing');
const add = `                    "candidate_n": candidate_n,
                    // [ENGINE-JSON-VIEW] 完整回合快照（盘面/资源/赛程/友人/合宿）
                    "view": serde_json::to_value(&self.view).unwrap_or(serde_json::Value::Null),
                    "scenario_extra": extra,`;
s = s.replace(anchor, add);
fs.writeFileSync(P, s);
console.log('engine json view patch applied');