#!/usr/bin/env node
// [FESTA2-3292] festa 段补 persons(EvaluationInfo) 与 command_gains(CommandGainActGauge)
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
const MARK = '// [FESTA2-3292]';
if (s.includes(MARK)) { console.log('already applied'); process.exit(0); }

const OLD = `    format!(
        r#"{{"ok":true,"acts":[{}],"advice":[{}],"checkpoints":[{}],"festa_info":{}}}"#,
        acts.join(","),
        adv.join(","),
        cps.join(","),
        info_json
    )
}`;
const NEW = `    ${MARK}
    let mut persons: Vec<String> = Vec::new();
    for p in read_items(read_ptr_at(ds, 32)) {
        persons.push(format!(
            r#"{{"target_id":{},"chara_id":{},"act_type":{}}}"#,
            read_obscured_int_at(p, 16),
            read_obscured_int_at(p, 36),
            read_obscured_int_at(p, 56)
        ));
    }
    let mut cgains: Vec<String> = Vec::new();
    for p in read_items(read_ptr_at(ds, 64)) {
        let cmd_type = read_obscured_int_at(p, 16);
        let mut gs: Vec<String> = Vec::new();
        for q in read_items(read_ptr_at(p, 40)) {
            gs.push(format!(
                r#"{{"act_type":{},"gain":{}}}"#,
                read_obscured_int_at(q, 16),
                read_obscured_int_at(q, 36)
            ));
        }
        cgains.push(format!(r#"{{"command_type":{},"gains":[{}]}}"#, cmd_type, gs.join(",")));
    }
    format!(
        r#"{{"ok":true,"acts":[{}],"advice":[{}],"checkpoints":[{}],"persons":[{}],"command_gains":[{}],"festa_info":{}}}"#,
        acts.join(","),
        adv.join(","),
        cps.join(","),
        persons.join(","),
        cgains.join(","),
        info_json
    )
}`;
const n = s.split(OLD).length - 1;
if (n !== 1) throw new Error('anchor count=' + n);
s = s.split(OLD).join(NEW);
fs.writeFileSync(P, s);
console.log('festa2 applied, bytes=' + Buffer.byteLength(s));