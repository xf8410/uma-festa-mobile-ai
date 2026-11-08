#!/usr/bin/env node
// [ENGINE-JSON-PANEL] 让引擎 JSON 带上「面板口径」的字段，手机端才能复刻 PC 面板：
//   baseline           = 本回合搜索基线（PC 面板里 +146 / +92 / -160 就是 candidate.score − baseline）
//   candidate_detail[] = {i,s,n,five[5],pt}（终端五维/PT 均值；PC 的 (速+0 耐-9 …) 用它算）
// 依据：matsuri-cli/src/online.rs render_decision()/terminal_delta()、matsuri-core/src/search.rs SearchCandidate
// 用法（CI 内对 clone 下来的上游打补丁，不改上游仓库）：
//   node apply_engine_json_panel.js /tmp/w/umaai-matsuri/crates/matsuri-ai/src/output.rs
const fs = require('fs');
const P = process.argv[2];
if (!P) throw new Error('usage: apply_engine_json_panel.js <crates/matsuri-ai/src/output.rs>');
let s = fs.readFileSync(P, 'utf8');
if (s.includes('[ENGINE-JSON-PANEL]')) { console.log('already applied'); process.exit(0); }
const anchor = `                        map.insert("expected_rank".to_string(), json!(summary.expected_rank));`;
if (!s.includes(anchor)) throw new Error('anchor missing');
const add = anchor + `
                        // [ENGINE-JSON-PANEL] 面板口径：基线 + 每候选终端五维/PT
                        map.insert("baseline".to_string(), json!(summary.baseline));
                        map.insert(
                            "candidate_detail".to_string(),
                            json!(summary
                                .candidates
                                .iter()
                                .map(|c| json!({
                                    "i": c.index,
                                    "s": c.score,
                                    "n": c.n,
                                    "five": c.five,
                                    "pt": c.pt
                                }))
                                .collect::<Vec<_>>()),
                        );`;
s = s.split(anchor).join(add);
fs.writeFileSync(P, s);
console.log('engine json panel patch applied');