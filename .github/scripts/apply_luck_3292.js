#!/usr/bin/env node
// [LUCK-3292] 跟随上游 umaai-matsuri 4bc0e653 的口径：
//  1) record.luck_turn_bonus 默认 70 → 100
//  2) 运气分显示投影 = (MAX_TURN − 已过回合) × bonus（只影响显示，不影响模拟）
//  3) 期望分投影 = 查定分 + 运气投影（评级必须跟着「投影后的分」查表，否则就是错的）
//  4) [search].threads → search_threads 配置（0=自动）
// 手机端还没有 rank 表，所以 rank 输出 null + rank_source 标注，绝不编一个假评级。
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
const MARK = '// [LUCK-3292]';
if (s.includes(MARK)) { console.log('already applied'); process.exit(0); }
const once = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error('anchor count=' + n + ' for: ' + JSON.stringify(a.slice(0, 70)));
  s = s.split(a).join(b);
};

// 1) 配置结构
once(
'    http_enabled: bool,      // default: true\n}',
'    http_enabled: bool,      // default: true\n' +
'    ' + MARK + ' 运气分显示投影的每回合加成（上游 record.luck_turn_bonus，默认 100）\n' +
'    luck_turn_bonus: i32,\n' +
'    ' + MARK + ' 搜索线程数（上游 [search].threads；0 = 自动）\n' +
'    search_threads: u32,\n' +
'}'
);

// 2) 默认值
once(
'            push_enabled: true,\n            http_enabled: true,\n        }',
'            push_enabled: true,\n            http_enabled: true,\n            luck_turn_bonus: 100,\n            search_threads: 0,\n        }'
);

// 3) POST /config 解析
once(
'                    "http_enabled" => {\n                        cfg.http_enabled = v == "true";\n                        changed = true;\n                    }\n                    _ => {}',
'                    "http_enabled" => {\n                        cfg.http_enabled = v == "true";\n                        changed = true;\n                    }\n' +
'                    "luck_turn_bonus" => {\n                        if let Ok(n) = v.parse::<i32>() {\n                            cfg.luck_turn_bonus = n.max(0);\n                            changed = true;\n                        }\n                    }\n' +
'                    "search_threads" => {\n                        if let Ok(n) = v.parse::<u32>() {\n                            cfg.search_threads = n.min(64);\n                            changed = true;\n                        }\n                    }\n' +
'                    _ => {}'
);

// 4) GET /config 输出
once(
'            r#"{{"push_host":"{}","push_port":{},"http_port":{},"push_interval_secs":{},"push_enabled":{},"http_enabled":{}}}"#,\n' +
'            self.push_host,\n            self.push_port,\n            self.http_port,\n            self.push_interval_secs,\n            self.push_enabled,\n            self.http_enabled\n        )',
'            r#"{{"push_host":"{}","push_port":{},"http_port":{},"push_interval_secs":{},"push_enabled":{},"http_enabled":{},"luck_turn_bonus":{},"search_threads":{}}}"#,\n' +
'            self.push_host,\n            self.push_port,\n            self.http_port,\n            self.push_interval_secs,\n            self.push_enabled,\n            self.http_enabled,\n            self.luck_turn_bonus,\n            self.search_threads\n        )'
);

// 5) /summary 里加 luck / expected 投影（用 mon/half 本地算已过回合，不依赖其他变量名）
const BLOCK = [
'    // [LUCK-3292] 上游口径：运气分显示投影 + 期望分投影（评级必须跟着投影分查表）',
'    {',
'        let max_turn: i32 = 77;',
'        let e_raw: i32 = (mon - 1) * 2 + (half - 1);',
'        let elapsed: i32 = if e_raw < 0 { 0 } else if e_raw > max_turn { max_turn } else { e_raw };',
'        let remaining = max_turn - elapsed;',
'        let cfg_l = unsafe { get_config() };',
'        let luck_projected = remaining * cfg_l.luck_turn_bonus;',
'        let base_s = five_status_final_score(spd + sta + pow_ + gut + wiz) + pt_score_value(spt, false);',
'        if let Some(pos) = __out.rfind(\'}\') {',
'            __out.insert_str(',
'                pos,',
'                &format!(',
'                    ",\\"luck\\":{{\\"turn_elapsed\\":{},\\"max_turn\\":{},\\"bonus_per_turn\\":{},\\"projected\\":{},\\"search_threads\\":{},\\"semantics\\":\\"upstream_luck_turn_projection\\"}},\\"expected\\":{{\\"base\\":{},\\"base_kind\\":\\"chokutei\\",\\"projected\\":{},\\"projection\\":\\"base+remaining*luck_bonus\\",\\"rank\\":null,\\"rank_source\\":\\"missing_rank_table\\"}}",',
'                    elapsed,',
'                    max_turn,',
'                    cfg_l.luck_turn_bonus,',
'                    luck_projected,',
'                    cfg_l.search_threads,',
'                    base_s,',
'                    base_s + luck_projected',
'                ),',
'            );',
'        }',
'    }',
].join('\n');
once(
'                    total_s, five_s, pt_s\n                ),\n            );\n        }\n    }',
'                    total_s, five_s, pt_s\n                ),\n            );\n        }\n    }\n' + BLOCK
);

fs.writeFileSync(P, s);
console.log('luck applied');