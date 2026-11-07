#!/usr/bin/env node
// [OFFSET-FIX-3292] 把 read_summary 里过期的硬编码偏移换成运行时解析的字段偏移。
// 幂等；锚点缺失则立刻失败退出，绝不静默改错。
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
const MARK = '// [OFFSET-FIX-3292]';
if (s.includes(MARK)) { console.log('already applied'); process.exit(0); }

function must(oldStr, count = 1) {
  const n = s.split(oldStr).length - 1;
  if (n !== count) throw new Error(`anchor count=${n} (want ${count}): ${JSON.stringify(oldStr.slice(0, 70))}`);
}
function rep(oldStr, newStr, count = 1) { must(oldStr, count); s = s.split(oldStr).join(newStr); }

// 1) 辅助函数
const ANCHOR_HELP = 'unsafe fn read_ptr_at(obj: *const c_void, field_offset: i32) -> *mut c_void {';
const HELPERS = `${MARK}
unsafe fn field_offset_of(obj: *const c_void, class: *mut c_void, name: &str) -> Option<i32> {
    if obj.is_null() || class.is_null() {
        return None;
    }
    let p = read_field_ptr(obj, class, name);
    if p.is_null() {
        return None;
    }
    let off = (p as usize).wrapping_sub(obj as usize);
    if off == 0 || off > 4096 {
        None
    } else {
        Some(off as i32)
    }
}

unsafe fn read_obscured_field(obj: *const c_void, class: *mut c_void, name: &str) -> i32 {
    match field_offset_of(obj, class, name) {
        Some(o) => read_obscured_int_at(obj, o),
        None => -1,
    }
}

`;
rep(ANCHOR_HELP, HELPERS + ANCHOR_HELP);

// 2) 十个属性读取（逐行替换）
const STATS = [
  ['spd', 248, '_speed'],
  ['sta', 268, '_stamina'],
  ['pow_', 288, '_power'],
  ['gut', 308, '_guts'],
  ['wiz', 328, '_wiz'],
  ['vit', 208, '_hp'],
  ['mvit', 228, '_maxHp'],
  ['mot', 1056, '_motivation'],
  ['spt', 704, '_skillPoint'],
  ['fan', 996, '_fanCount'],
];
for (const [v, off, field] of STATS) {
  const oldLine = `    let ${v} = read_obscured_int_at(chara_obj, ${off}); // ${field}`;
  const newLine = `    let ${v} = read_obscured_field(chara_obj, chara_class, "${field}");`;
  rep(oldLine, newLine);
}

// 3) totalTurnNum / scenarioId
rep('    let raw_total_turn_num = read_obscured_int_at(sm_obj as *const c_void, 68); // _totalTurnNum',
    '    let raw_total_turn_num = read_obscured_field(sm_obj as *const c_void, sm_class, "_totalTurnNum");');
rep('    let sid = read_obscured_int_at(chara_obj, 568); // _scenarioId',
    '    let sid = read_obscured_field(chara_obj, chara_class, "_scenarioId");');

// 4) 两处已失效的 getter 名
rep('"get_TargetRaceArray"', '"get_TargetRaceIdArray"');
rep('"get_WorkSingleModeData"', '"get_SingleMode"');

// 5) 端点清单 + 路由
rep('    "/debug/turn_probe",', '    "/debug/turn_probe",\n    "/debug/selftest",');
rep('    } else if path == "/debug/turn_probe" {',
    '    } else if path == "/debug/selftest" {\n        selftest_offsets()\n    } else if path == "/debug/turn_probe" {');

// 6) selftest 函数
const ANCHOR_FN = 'unsafe fn read_summary_inner() -> String {';
const SELFTEST = `${MARK} selftest
unsafe fn selftest_offsets() -> String {
    let image = get_image();
    if image.is_null() {
        return r#"{"error":"image_null"}"#.to_string();
    }
    let wdm_class = find_class(image, to_cstr("Gallop").as_ptr(), to_cstr("WorkDataManager").as_ptr());
    if wdm_class.is_null() {
        return r#"{"error":"no_wdm"}"#.to_string();
    }
    let wdm = get_singleton(wdm_class);
    if wdm.is_null() {
        return r#"{"error":"no_wdm_inst"}"#.to_string();
    }
    let sm_class = find_class(image, to_cstr("Gallop").as_ptr(), to_cstr("WorkSingleModeData").as_ptr());
    let chara_class = find_class(image, to_cstr("Gallop").as_ptr(), to_cstr("WorkSingleModeCharaData").as_ptr());
    let sm = if sm_class.is_null() {
        ptr::null()
    } else {
        call_getter_ref(wdm_class, wdm, "get_SingleMode")
    };
    let chara = if sm.is_null() || sm_class.is_null() {
        ptr::null()
    } else {
        call_getter_ref(sm_class, sm, "get_Character")
    };

    let mut rows: Vec<String> = Vec::new();
    let names = [
        "_speed", "_stamina", "_power", "_guts", "_wiz", "_hp", "_maxHp",
        "_motivation", "_skillPoint", "_fanCount", "_scenarioId",
    ];
    for name in names {
        let off = field_offset_of(chara, chara_class, name);
        let val = match off {
            Some(o) => read_obscured_int_at(chara, o),
            None => -1,
        };
        rows.push(format!(
            r#"{{"field":"{}","offset":{},"value":{}}}"#,
            name,
            off.map(|o| o.to_string()).unwrap_or_else(|| "null".to_string()),
            val
        ));
    }
    let tt = field_offset_of(sm as *const c_void, sm_class, "_totalTurnNum");
    rows.push(format!(
        r#"{{"field":"_totalTurnNum","offset":{},"value":{}}}"#,
        tt.map(|o| o.to_string()).unwrap_or_else(|| "null".to_string()),
        match tt {
            Some(o) => read_obscured_int_at(sm as *const c_void, o),
            None => -1,
        }
    ));

    format!(
        r#"{{"ok":true,"chara_ok":{},"sm_ok":{},"fields":[{}]}}"#,
        !chara.is_null(),
        !sm.is_null(),
        rows.join(",")
    )
}

`;
rep(ANCHOR_FN, SELFTEST + ANCHOR_FN);

fs.writeFileSync(P, s);
console.log('patched ok, bytes=' + Buffer.byteLength(s));