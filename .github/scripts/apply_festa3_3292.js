#!/usr/bin/env node
// [FESTA3-3292] 再补 commands[]（CommandInfo：command_id 级增益）与 not_level_up_act_types
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
const MARK = '// [FESTA3-3292]';
if (s.includes(MARK)) { console.log('already applied'); process.exit(0); }

const OLD = `    format!(
        r#"{{"ok":true,"acts":[{}],"advice":[{}],"checkpoints":[{}],"persons":[{}],"command_gains":[{}],"festa_info":{}}}"#,
        acts.join(","),
        adv.join(","),
        cps.join(","),
        persons.join(","),
        cgains.join(","),
        info_json
    )
}`;
const NEW = `    ${MARK}
    let mut cmds: Vec<String> = Vec::new();
    for p in read_items(read_ptr_at(ds, 24)) {
        let mut gs: Vec<String> = Vec::new();
        for q in read_items(read_ptr_at(p, 64)) {
            gs.push(format!(
                r#"{{"act_type":{},"gain":{}}}"#,
                read_obscured_int_at(q, 16),
                read_obscured_int_at(q, 36)
            ));
        }
        cmds.push(format!(
            r#"{{"command_type":{},"command_id":{},"gains":[{}]}}"#,
            read_obscured_int_at(p, 16),
            read_obscured_int_at(p, 36),
            gs.join(",")
        ));
    }
    let not_level_up = read_il2cpp_int_list(read_ptr_at(read_ptr_at(ds, 72), 40));
    format!(
        r#"{{"ok":true,"acts":[{}],"advice":[{}],"checkpoints":[{}],"persons":[{}],"command_gains":[{}],"commands":[{}],"not_level_up_act_types":{:?},"festa_info":{}}}"#,
        acts.join(","),
        adv.join(","),
        cps.join(","),
        persons.join(","),
        cgains.join(","),
        cmds.join(","),
        not_level_up,
        info_json
    )
}`;
const n = s.split(OLD).length - 1;
if (n !== 1) throw new Error('anchor count=' + n);
s = s.split(OLD).join(NEW);
fs.writeFileSync(P, s);
console.log('festa3 applied, bytes=' + Buffer.byteLength(s));