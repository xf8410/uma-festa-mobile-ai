#!/usr/bin/env node
// [FESTA-CMD-3292] 祭典杯（Festa）训练命令是 5101–5105，但 SO 原来的归一化只认 legacy 101/105/102/103/106
//   → normalize_training_command_id(5101) 返回 None → 支援卡 is_shining 全 null（彩圈读不到）。
// 实测顺序（live /summary 的 trainings[].partners 反推）：
//   5101 速(乐透心/跳舞城) 5102 耐(樱花千代王) 5103 力(美妙姿势) 5104 根(空) 5105 智(青春永驻)
// 映射到 legacy：5101→101 5102→105 5103→102 5104→103 5105→106
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
if (s.includes('[FESTA-CMD-3292]')) { console.log('already applied'); process.exit(0); }
const anchor = 'fn normalize_training_command_id(command_id: i32) -> Option<i32> {\n    match command_id {';
if (!s.includes(anchor)) throw new Error('anchor missing');
const add = [
  '// [FESTA-CMD-3292] 祭典杯（Festa）训练命令 → legacy 训练命令',
  '//   5101 速 / 5102 耐 / 5103 力 / 5104 根 / 5105 智（实测反推）',
  'const CMD_FESTA_SPEED: i32 = 5101;',
  'const CMD_FESTA_STAMINA: i32 = 5102;',
  'const CMD_FESTA_POWER: i32 = 5103;',
  'const CMD_FESTA_GUTS: i32 = 5104;',
  'const CMD_FESTA_WISDOM: i32 = 5105;',
  '',
  anchor,
  '        // [FESTA-CMD-3292] Festa 稽古命令先折到 legacy 训练 id',
  '        CMD_FESTA_SPEED => Some(CMD_SPEED),',
  '        CMD_FESTA_STAMINA => Some(CMD_STAMINA),',
  '        CMD_FESTA_POWER => Some(CMD_POWER),',
  '        CMD_FESTA_GUTS => Some(CMD_GUTS),',
  '        CMD_FESTA_WISDOM => Some(CMD_WISDOM),',
].join('\n');
s = s.replace(anchor, add);
fs.writeFileSync(P, s);
console.log('festa-cmd patch applied');