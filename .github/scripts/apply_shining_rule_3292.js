#!/usr/bin/env node
// [SHINING-RULE-3292] 彩圈按上游引擎规则算（不自己发明）：
//   umaai-next/crates/umasim/src/game/traits.rs:362
//     PersonType::Card => person.train_type() == train && person.friendship() >= 80
//     其他类型（友人/NPC/理事长/记者）=> false
// 关键：把卡的 command_id 与当前训练都折成 0–4 训练下标（速0 耐1 力2 根3 智4），
//       祭典杯命令 5101–5105 也一起折（之前只认 legacy 101..106 → 全 None）。
// 另补 train_type 字段（0–4，-1=非卡位），App 面板直接展示得意训练。
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
const MARK = '[SHINING-RULE-3292]';
if (s.includes(MARK)) { console.log('already applied'); process.exit(0); }

const anchorFn = '// URA turn thresholds for max vital equivalent calculation';
if (!s.includes(anchorFn)) throw new Error('anchorFn missing');
const helper = [
  '',
  '// ' + MARK + ' 训练命令 → 训练下标（速0 耐1 力2 根3 智4；未知 -1）',
  'fn train_index_of_cmd(command_id: i32) -> i32 {',
  '    match command_id {',
  '        5101 | 101 | 601 => 0,',
  '        5102 | 105 | 602 => 1,',
  '        5103 | 102 | 603 => 2,',
  '        5104 | 103 | 604 => 3,',
  '        5105 | 106 | 605 => 4,',
  '        _ => -1,',
  '    }',
  '}',
  '',
].join('\n');
s = s.replace(anchorFn, helper + anchorFn);

const start = s.indexOf('let is_shining: Option<bool> = if is_support_card {');
if (start < 0) throw new Error('is_shining block not found');
const endMark = '                                        // NPC and scenario partners are not equipped support cards.\n                                        None\n                                    };';
const endIdx = s.indexOf(endMark, start);
if (endIdx < 0) throw new Error('is_shining end anchor not found');
const block = [
  'let is_shining: Option<bool> = if is_support_card {',
  '                                        // ' + MARK + ' 引擎同款：卡位 && 得意训练==当前训练 && 羁绊>=80',
  '                                        let card_idx = support_command_by_position',
  '                                            .get(&partner_id)',
  '                                            .copied()',
  '                                            .map(train_index_of_cmd)',
  '                                            .unwrap_or(-1);',
  '                                        let cur_idx = train_index_of_cmd(cid);',
  '                                        if card_idx >= 0 && cur_idx >= 0 {',
  '                                            Some(',
  '                                                card_idx == cur_idx',
  '                                                    && current_bond.map_or(false, |b| b >= 80),',
  '                                            )',
  '                                        } else {',
  '                                            None',
  '                                        }',
  '                                    } else {',
  '                                        None',
  '                                    };',
].join('\n');
s = s.slice(0, start) + block + s.slice(endIdx + endMark.length);

const jsonOld = '"partner_type":{},"name":"{}"';
if (s.includes(jsonOld)) s = s.replace(jsonOld, '"partner_type":{},"name":"{}","train_type":{}');
const tailA = '                                        json_escape(&partner_name),\n                                    ));';
const tailB = '                                        json_escape(&partner_name),\n                                        support_command_by_position.get(&partner_id).copied().map(train_index_of_cmd).unwrap_or(-1)\n                                    ));';
if (s.includes(tailA)) s = s.split(tailA).join(tailB);
else console.log('warn: tail anchor missing');

fs.writeFileSync(P, s);
console.log('shining rule patch applied');