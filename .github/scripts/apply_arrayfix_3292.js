#!/usr/bin/env node
// [ARRAY-FIX-3292] 修 read_il2cpp_int_list 的内联 ObscuredInt[] 误当指针解引用（SIGSEGV 真凶）；
// 并把 v1 的运行时字段查找回退成已由 /fields 实测确认正确的固定偏移；重写 /debug/selftest。
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
const MARK = '// [ARRAY-FIX-3292]';
if (s.includes(MARK)) { console.log('already applied'); process.exit(0); }

const rep = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error(`anchor count=${n}: ${JSON.stringify(a.slice(0, 60))}`);
  s = s.split(a).join(b);
};

// 1) 回退 v1 的运行时字段查找（/fields 实测偏移本来就是对的）
const REVERT = [
  ['spd', '_speed', 248], ['sta', '_stamina', 268], ['pow_', '_power', 288],
  ['gut', '_guts', 308], ['wiz', '_wiz', 328], ['vit', '_hp', 208],
  ['mvit', '_maxHp', 228], ['mot', '_motivation', 1056], ['spt', '_skillPoint', 704],
  ['fan', '_fanCount', 996],
];
for (const [v, field, off] of REVERT) {
  rep(`    let ${v} = read_obscured_field(chara_obj, chara_class, "${field}");`,
      `    let ${v} = read_obscured_int_at(chara_obj, ${off}); // ${field}`);
}
rep('    let raw_total_turn_num = read_obscured_field(sm_obj as *const c_void, sm_class, "_totalTurnNum");',
    '    let raw_total_turn_num = read_obscured_int_at(sm_obj as *const c_void, 68); // _totalTurnNum');
rep('    let sid = read_obscured_field(chara_obj, chara_class, "_scenarioId");',
    '    let sid = read_obscured_int_at(chara_obj, 568); // _scenarioId');

// 2) 修 read_il2cpp_int_list
const OLD_FN = `unsafe fn read_il2cpp_int_list(list_ptr: *const c_void) -> Vec<i32> {
    if list_ptr.is_null() {
        return Vec::new();
    }
    let base = list_ptr as *const u8;
    let count = std::ptr::read_unaligned::<usize>(base.add(IL2CPP_LIST_COUNT_OFF) as *const usize);
    if count > 10000 {
        return Vec::new();
    }
    let mut result = Vec::with_capacity(count);
    for i in 0..count {
        let elem = read_obscured_int_at(
            std::ptr::read_unaligned::<*mut c_void>(
                base.add(IL2CPP_LIST_ITEMS_OFF + i * IL2CPP_LIST_ITEM_SIZE) as *const *mut c_void,
            ) as *const c_void,
            IL2CPP_OBSCURED_INT_KEY_OFF as i32,
        );
        result.push(elem);
    }
    result
}`;
const NEW_FN = `${MARK} read_il2cpp_int_list
unsafe fn read_il2cpp_int_list(list_ptr: *const c_void) -> Vec<i32> {
    if list_ptr.is_null() {
        return Vec::new();
    }
    let base = list_ptr as *const u8;
    let count = std::ptr::read_unaligned::<usize>(base.add(IL2CPP_LIST_COUNT_OFF) as *const usize);
    if count > 256 {
        return Vec::new();
    }
    let data_start = base.add(IL2CPP_LIST_ITEMS_OFF);
    let mut result = Vec::with_capacity(count);
    for i in 0..count {
        // ObscuredInt 是内联结构体：currentCryptoKey@0, hiddenValue@4，步长 0x14
        let elem = data_start.add(i * 0x14);
        let key = std::ptr::read_unaligned::<i32>(elem as *const i32);
        let hidden = std::ptr::read_unaligned::<i32>(elem.add(4) as *const i32);
        result.push(hidden ^ key);
    }
    result
}`;
rep(OLD_FN, NEW_FN);

// 3) 重写 selftest（改成固定偏移 + 彩蛋数组实测）
const START = '// [OFFSET-FIX-3292] selftest\nunsafe fn selftest_offsets() -> String {';
const END_ANCHOR = '\nunsafe fn read_summary_inner() -> String {';
const i0 = s.indexOf(START);
const i1 = s.indexOf(END_ANCHOR, i0);
if (i0 < 0 || i1 < 0) throw new Error('selftest block not found');
const NEW_SELFTEST = `${MARK} selftest
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

    let pairs: [(i32, &str); 13] = [
        (208, "_hp"),
        (228, "_maxHp"),
        (248, "_speed"),
        (268, "_stamina"),
        (288, "_power"),
        (308, "_guts"),
        (328, "_wiz"),
        (348, "MaxSpeed"),
        (568, "_scenarioId"),
        (704, "SkillPoint"),
        (944, "RunningStyle"),
        (996, "_fanCount"),
        (1056, "_motivation"),
    ];
    let mut rows: Vec<String> = Vec::new();
    for (off, name) in pairs {
        let val = read_obscured_int_at(chara, off);
        rows.push(format!(
            r#"{{"field":"{}","offset":{},"value":{}}}"#,
            name, off, val
        ));
    }
    let total_turn = read_obscured_int_at(sm as *const c_void, 68);
    rows.push(format!(
        r#"{{"field":"_totalTurnNum","offset":68,"value":{}}}"#,
        total_turn
    ));
    let effects = read_il2cpp_int_list(read_ptr_at(chara, 1080));
    format!(
        r#"{{"ok":true,"chara_ok":{},"sm_ok":{},"effects":{:?},"fields":[{}]}}"#,
        !chara.is_null(),
        !sm.is_null(),
        effects,
        rows.join(",")
    )
}
`;
s = s.slice(0, i0) + NEW_SELFTEST + s.slice(i1 + 1);

fs.writeFileSync(P, s);
console.log('array-fix applied, bytes=' + Buffer.byteLength(s));