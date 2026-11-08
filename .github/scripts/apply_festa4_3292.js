#!/usr/bin/env node
// [FESTA4-3292] 兼容手机 App 0.7.4 的字段名：同时输出 command_info / gain_gauges / evaluation_info 与 acts[].friend_outing
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
const MARK = '// [FESTA4-3292]';
if (s.includes(MARK)) { console.log('already applied'); process.exit(0); }

const rep = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error(`anchor count=${n}: ${JSON.stringify(a.slice(0, 60))}`);
  s = s.split(a).join(b);
};

// 1) acts 里加 friend_outing 别名（App 0.7.4 读的是这个名字）
rep('r#"{{"act_type":{},"gauge":{},"level":{},"need_gauge":{},"state":{},"advice_id":{},"friend_outing_gain_act_level":{}}}"#,',
    'r#"{{"act_type":{},"gauge":{},"level":{},"need_gauge":{},"state":{},"advice_id":{},"friend_outing":{},"friend_outing_gain_act_level":{}}}"#,');

rep(`            read_obscured_int_at(p, 96),
            read_obscured_int_at(p, 116),
            read_obscured_int_at(p, 136)
        ));`,
`            read_obscured_int_at(p, 96),
            read_obscured_int_at(p, 116),
            read_obscured_int_at(p, 136),
            read_obscured_int_at(p, 136)
        ));`);

// 2) 末尾再输出三组别名数组
rep('r#"{{"ok":true,"acts":[{}],"advice":[{}],"checkpoints":[{}],"persons":[{}],"command_gains":[{}],"commands":[{}],"not_level_up_act_types":{:?},"festa_info":{}}}"#,',
    'r#"{{"ok":true,"acts":[{}],"advice":[{}],"checkpoints":[{}],"persons":[{}],"command_gains":[{}],"commands":[{}],"not_level_up_act_types":{:?},"command_info":[{}],"gain_gauges":[{}],"evaluation_info":[{}],"festa_info":{}}}"#,');

rep(`        cmds.join(","),
        not_level_up,
        info_json`,
`        cmds.join(","),
        not_level_up,
        cmds.join(","),
        cgains.join(","),
        persons.join(","),
        info_json`);

// 幂等标记
rep('    let not_level_up = read_il2cpp_int_list(', '    // [FESTA4-3292] 兼容 App 0.7.4 字段名\n    let not_level_up = read_il2cpp_int_list(');

fs.writeFileSync(P, s);
console.log('festa4 applied, bytes=' + Buffer.byteLength(s));