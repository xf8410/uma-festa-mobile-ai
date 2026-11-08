#!/usr/bin/env node
// [FESTA-3292] 剧本 15：从 WorkSingleModeScenarioFesta 读出演目/教诲/检查点，塞进 /summary 的 festa 段。
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
const MARK = '// [FESTA-3292]';
if (s.includes(MARK)) { console.log('already applied'); process.exit(0); }

const rep = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error(`anchor count=${n}: ${JSON.stringify(a.slice(0, 60))}`);
  s = s.split(a).join(b);
};

// 1) 剧本名
rep('        14 => "Ramen",\n        _ => "Unknown",', '        14 => "Ramen",\n        15 => "Festa",\n        _ => "Unknown",');

// 2) festa_json 函数（闭包内必须自带 unsafe 块）
const FN = `${MARK}
unsafe fn festa_json(chara_obj: *const c_void) -> String {
    // WorkSingleModeCharaData.<ScenarioFesta>k__BackingField @1232
    let scenario = read_ptr_at(chara_obj, 1232);
    if !is_plausible_ptr(scenario) {
        return r#"{"ok":false,"error":"scenario_festa_null"}"#.to_string();
    }
    let ds = read_ptr_at(scenario, 16);
    if !is_plausible_ptr(ds) {
        return r#"{"ok":false,"error":"festa_dataset_null"}"#.to_string();
    }
    let info = read_ptr_at(ds, 16);
    let info_json = if is_plausible_ptr(info) {
        format!(
            r#"{{"summer_camp_remain_turn":{},"max_act_level":{},"act_training_step":{}}}"#,
            read_obscured_int_at(info, 16),
            read_obscured_int_at(info, 36),
            read_obscured_int_at(info, 56)
        )
    } else {
        "null".to_string()
    };
    let read_items = |arr: *const c_void| -> Vec<*const c_void> {
        let mut out: Vec<*const c_void> = Vec::new();
        if !is_plausible_ptr(arr) {
            return out;
        }
        unsafe {
            let n = std::ptr::read_unaligned::<usize>((arr as *const u8).add(0x18) as *const usize);
            if n > 64 {
                return out;
            }
            for i in 0..n {
                let p = std::ptr::read_unaligned::<*mut c_void>(
                    (arr as *const u8).add(0x20 + i * 8) as *const *mut c_void,
                );
                if is_plausible_ptr(p) {
                    out.push(p);
                }
            }
        }
        out
    };
    let mut acts: Vec<String> = Vec::new();
    for p in read_items(read_ptr_at(ds, 48)) {
        acts.push(format!(
            r#"{{"act_type":{},"gauge":{},"level":{},"need_gauge":{},"state":{},"advice_id":{},"friend_outing_gain_act_level":{}}}"#,
            read_obscured_int_at(p, 16),
            read_obscured_int_at(p, 36),
            read_obscured_int_at(p, 56),
            read_obscured_int_at(p, 76),
            read_obscured_int_at(p, 96),
            read_obscured_int_at(p, 116),
            read_obscured_int_at(p, 136)
        ));
    }
    let mut adv: Vec<String> = Vec::new();
    for p in read_items(read_ptr_at(ds, 40)) {
        adv.push(format!(
            r#"{{"advice_id":{},"fusion_advice_id":{}}}"#,
            read_obscured_int_at(p, 16),
            read_obscured_int_at(p, 36)
        ));
    }
    let mut cps: Vec<String> = Vec::new();
    for p in read_items(read_ptr_at(ds, 56)) {
        cps.push(format!(
            r#"{{"schedule_id":{},"result_type":{}}}"#,
            read_obscured_int_at(p, 16),
            read_obscured_int_at(p, 36)
        ));
    }
    format!(
        r#"{{"ok":true,"acts":[{}],"advice":[{}],"checkpoints":[{}],"festa_info":{}}}"#,
        acts.join(","),
        adv.join(","),
        cps.join(","),
        info_json
    )
}

`;
rep('unsafe fn read_summary_inner() -> String {', FN + 'unsafe fn read_summary_inner() -> String {');

// 3) 注入到 summary（在末尾 } 前插入 "festa"）
rep(`    log_predict_step("S:json_done");
    __json_out
}`,
`    log_predict_step("S:festa");
    let mut __out = __json_out;
    if sid == 15 {
        let fj = festa_json(chara_obj);
        if let Some(pos) = __out.rfind('}') {
            __out.insert_str(pos, &format!(",\\"festa\\":{}", fj));
        }
    }
    log_predict_step("S:json_done");
    __out
}`);

fs.writeFileSync(P, s);
console.log('festa applied, bytes=' + Buffer.byteLength(s));