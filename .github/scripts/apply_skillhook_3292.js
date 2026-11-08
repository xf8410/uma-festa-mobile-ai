#!/usr/bin/env node
// [SKILLHOOK-3292] 技能提示「托管 hook」：
//  1) 元素类型是 List<Gallop.WorkSingleModeCharaData/SkillTips>（嵌套类），
//     之前按 Gallop.SkillTips 的 16/36/56 硬偏移读 —— 嵌套类布局不同 → 全部解码成 0 → 列表看起来是空的。
//     现在改为「元素运行时类 + 字段名」取偏移，raw 偏移只作兜底。
//  2) 增加托管 hook：hook WorkSingleModeCharaData.get_SkillTipsList（游戏自己取技能提示的入口），
//     在回调里只做裸内存读（不 invoke 托管方法），把结果写进 SKILL_TIPS_GROUPS 缓存。
//  3) 新增 /debug/skilltips_probe 诊断端点：getter / 字段 / hook 缓存 三条路对比 + 元素类字段表。
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
const MARK = '// [SKILLHOOK-3292]';
if (s.includes(MARK)) { console.log('already applied'); process.exit(0); }

const once = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error(`anchor count=${n} for: ${JSON.stringify(a.slice(0, 70))}`);
  s = s.split(a).join(b);
};

// ---------- 1) 插入托管 hook + 诊断代码块 ----------
const CODE = `// [SKILLHOOK-3292] 技能提示托管 hook —— 见 apply_skillhook_3292.js
static SKILL_TIPS_HOOK_INSTALLED: AtomicBool = AtomicBool::new(false);
static SKILL_TIPS_HOOK_HITS: AtomicU64 = AtomicU64::new(0);
static SKILL_TIPS_GETTER_ADDR: AtomicU64 = AtomicU64::new(0);
static SKILL_TIPS_LIST_PTR: Mutex<usize> = Mutex::new(0);
static SKILL_TIPS_GROUPS: Mutex<Vec<(i32, i32, i32)>> = Mutex::new(Vec::new());
static mut ORIG_SKILL_TIPS_PROLOGUE: [u8; 16] = [0; 16];

/// 读 Il2Cpp List<T> 的元素指针数组（裸内存，不调托管代码）
unsafe fn walk_obj_list(list: *mut c_void) -> Vec<*mut c_void> {
    let mut out: Vec<*mut c_void> = Vec::new();
    if list.is_null() {
        return out;
    }
    let lb = list as *const u8;
    let count = std::ptr::read_unaligned::<usize>(lb.add(0x18) as *const usize);
    let items = std::ptr::read_unaligned::<*mut c_void>(lb.add(0x10) as *const *mut c_void);
    if count == 0 || count > 400 || items.is_null() {
        return out;
    }
    for i in 0..count {
        let ep = std::ptr::read_unaligned::<*mut c_void>(
            (items as *const u8).add(0x20 + i * 8) as *const *mut c_void,
        );
        if !ep.is_null() {
            out.push(ep);
        }
    }
    out
}

unsafe fn list_count_of(list: *mut c_void) -> usize {
    if list.is_null() {
        return 0;
    }
    let c = std::ptr::read_unaligned::<usize>((list as *const u8).add(0x18) as *const usize);
    if c > 400 { 0 } else { c }
}

/// 按「字段名 → 偏移」读内联 ObscuredInt；名字对不上返回 -1
unsafe fn read_obscured_by_names(ep: *mut c_void, class: *mut c_void, names: &[&str]) -> i32 {
    for n in names {
        let v = read_obscured_field(ep, class, n);
        if v >= 0 {
            return v;
        }
    }
    -1
}

/// 读一个 SkillTips 元素（嵌套类）：优先字段名，兜底 raw 偏移
unsafe fn read_skill_tip_elem(ep: *mut c_void) -> Option<(i32, i32, i32)> {
    if ep.is_null() {
        return None;
    }
    let eclass = get_class_from_object(ep);
    let mut gid = -1;
    let mut rar = -1;
    let mut lvl = -1;
    if !eclass.is_null() {
        gid = read_obscured_by_names(
            ep,
            eclass,
            &["<GroupId>k__BackingField", "groupId", "_groupId", "GroupId"],
        );
        rar = read_obscured_by_names(
            ep,
            eclass,
            &["<Rarity>k__BackingField", "rarity", "_rarity", "Rarity"],
        );
        lvl = read_obscured_by_names(
            ep,
            eclass,
            &["<Level>k__BackingField", "level", "_level", "Level"],
        );
    }
    if gid <= 0 && rar <= 0 {
        gid = read_obscured_int_at(ep, 16);
        rar = read_obscured_int_at(ep, 36);
        lvl = read_obscured_int_at(ep, 56);
    }
    if gid > 0 || rar > 0 {
        Some((gid.max(0), rar.max(0), lvl.max(0)))
    } else {
        None
    }
}

unsafe fn decode_skill_tips_list(list: *mut c_void) -> Vec<(i32, i32, i32)> {
    walk_obj_list(list)
        .into_iter()
        .filter_map(|e| read_skill_tip_elem(e))
        .collect()
}

unsafe fn tips_list_json(list: *mut c_void) -> String {
    if list.is_null() {
        return r#"{"ptr":"0x0","count":0,"decoded":0,"tips":[]}"#.to_string();
    }
    let count = list_count_of(list);
    let tips = decode_skill_tips_list(list);
    let tj: Vec<String> = tips
        .iter()
        .map(|(g, r, l)| format!(r#"{{"group_id":{},"rarity":{},"level":{}}}"#, g, r, l))
        .collect();
    format!(
        r#"{{"ptr":"0x{:x}","count":{},"decoded":{},"tips":[{}]}}"#,
        list as usize,
        count,
        tips.len(),
        tj.join(",")
    )
}

/// 托管 hook 回调：只做裸内存读，不 invoke 托管方法（避免 MT 崩溃）
extern "C" fn skill_tips_getter_hook(this: *mut c_void) -> *mut c_void {
    let trampoline = unsafe { interceptor_get_trampoline(skill_tips_getter_hook as usize) };
    if trampoline == 0 {
        return ptr::null_mut();
    }
    type FnGet = unsafe extern "C" fn(*mut c_void) -> *mut c_void;
    let original: FnGet = unsafe { std::mem::transmute(trampoline) };
    let ret = original(this);
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
        SKILL_TIPS_HOOK_HITS.fetch_add(1, Ordering::Relaxed);
        if !ret.is_null() {
            if let Ok(mut p) = SKILL_TIPS_LIST_PTR.try_lock() {
                *p = ret as usize;
            }
            if let Ok(mut c) = SKILL_TIPS_GROUPS.try_lock() {
                let v = decode_skill_tips_list(ret);
                if !v.is_empty() {
                    *c = v;
                }
            }
        }
    }));
    ret
}

unsafe fn install_skill_tips_hook() {
    if SKILL_TIPS_HOOK_INSTALLED.load(Ordering::Relaxed) || API.is_null() {
        return;
    }
    let image = match get_image() {
        img if !img.is_null() => img,
        _ => return,
    };
    let class = find_class(
        image,
        to_cstr("Gallop").as_ptr(),
        to_cstr("WorkSingleModeCharaData").as_ptr(),
    );
    if class.is_null() {
        set_hook_status("skill.tips", "failed: class_not_found");
        return;
    }
    let addr = find_method_addr(class, "get_SkillTipsList", 0);
    if addr == 0 {
        set_hook_status("skill.tips", "failed: method_not_found");
        return;
    }
    SKILL_TIPS_GETTER_ADDR.store(addr as u64, Ordering::Relaxed);
    if install_hook_safe(
        "SkillTipsList",
        addr,
        skill_tips_getter_hook as usize,
        &mut ORIG_SKILL_TIPS_PROLOGUE,
    ) {
        SKILL_TIPS_HOOK_INSTALLED.store(true, Ordering::Relaxed);
        set_hook_status("skill.tips", &format!("resolved@0x{:x}", addr));
        ura_log(2, &format!("skill tips hook installed @0x{:x}", addr));
    } else {
        set_hook_status("skill.tips", "failed: hook_rejected");
    }
}

static SKILL_MODEL_HOOK_INSTALLED: AtomicBool = AtomicBool::new(false);
static SKILL_MODEL_HOOK_HITS: AtomicU64 = AtomicU64::new(0);
static SKILL_MODEL_LIST_PTR: Mutex<usize> = Mutex::new(0);
static mut ORIG_SKILL_MODEL_PROLOGUE: [u8; 16] = [0; 16];

/// 技能页模型 hook：get_SkillInfoList —— 只存 List 指针，解析放到 HTTP 线程
extern "C" fn skill_model_list_hook(this: *mut c_void) -> *mut c_void {
    let trampoline = unsafe { interceptor_get_trampoline(skill_model_list_hook as usize) };
    if trampoline == 0 {
        return ptr::null_mut();
    }
    type FnGet = unsafe extern "C" fn(*mut c_void) -> *mut c_void;
    let original: FnGet = unsafe { std::mem::transmute(trampoline) };
    let ret = original(this);
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
        SKILL_MODEL_HOOK_HITS.fetch_add(1, Ordering::Relaxed);
        if !ret.is_null() {
            if let Ok(mut p) = SKILL_MODEL_LIST_PTR.try_lock() {
                *p = ret as usize;
            }
        }
    }));
    ret
}

unsafe fn install_skill_model_hook() {
    if SKILL_MODEL_HOOK_INSTALLED.load(Ordering::Relaxed) || API.is_null() {
        return;
    }
    let image = match get_image() {
        img if !img.is_null() => img,
        _ => return,
    };
    let class = find_class(
        image,
        to_cstr("Gallop").as_ptr(),
        to_cstr("SingleModeSkillLearningModel").as_ptr(),
    );
    if class.is_null() {
        set_hook_status("skill.model", "failed: class_not_found");
        return;
    }
    let addr = find_method_addr(class, "get_SkillInfoList", 0);
    if addr == 0 {
        set_hook_status("skill.model", "failed: method_not_found");
        return;
    }
    if install_hook_safe(
        "SkillInfoList",
        addr,
        skill_model_list_hook as usize,
        &mut ORIG_SKILL_MODEL_PROLOGUE,
    ) {
        SKILL_MODEL_HOOK_INSTALLED.store(true, Ordering::Relaxed);
        set_hook_status("skill.model", &format!("resolved@0x{:x}", addr));
    } else {
        set_hook_status("skill.model", "failed: hook_rejected");
    }
}

/// 技能页模型 List 解析（HTTP 线程，允许 invoke）
unsafe fn skill_model_json() -> String {
    let p = SKILL_MODEL_LIST_PTR.lock().map(|v| *v).unwrap_or(0) as *mut c_void;
    if p.is_null() {
        return format!(
            r#"{{"hook_hits":{},"installed":{},"ptr":"0x0","count":0,"items":[]}}"#,
            SKILL_MODEL_HOOK_HITS.load(Ordering::Relaxed),
            SKILL_MODEL_HOOK_INSTALLED.load(Ordering::Relaxed)
        );
    }
    let elems = walk_obj_list(p);
    let mut items: Vec<String> = Vec::new();
    for e in elems.iter().take(60) {
        let ec = get_class_from_object(*e);
        if ec.is_null() {
            continue;
        }
        let gid = call_getter_int(ec, *e as *const c_void, "GetFirstSkillGroupId");
        let hl = call_getter_int(ec, *e as *const c_void, "GetHintLv");
        let np = call_getter_int(ec, *e as *const c_void, "GetNeedSkillPoint");
        items.push(format!(
            r#"{{"group_id":{},"hint_lv":{},"need_point":{}}}"#,
            gid, hl, np
        ));
    }
    let _ = elems;
    format!(
        r#"{{"hook_hits":{},"installed":{},"ptr":"0x{:x}","count":{},"items":[{}]}}"#,
        SKILL_MODEL_HOOK_HITS.load(Ordering::Relaxed),
        SKILL_MODEL_HOOK_INSTALLED.load(Ordering::Relaxed),
        p as usize,
        elems.len(),
        items.join(",")
    )
}

/// /debug/skilltips_probe —— 三条路对比 + 元素类字段表
unsafe fn debug_skilltips_probe() -> String {
    if API.is_null() {
        return r#"{"error":"api_null"}"#.to_string();
    }
    let image = get_image();
    if image.is_null() {
        return r#"{"error":"image_null"}"#.to_string();
    }
    let wdm_class = find_class(
        image,
        to_cstr("Gallop").as_ptr(),
        to_cstr("WorkDataManager").as_ptr(),
    );
    if wdm_class.is_null() {
        return r#"{"error":"no_wdm"}"#.to_string();
    }
    let wdm_inst = get_singleton(wdm_class);
    if wdm_inst.is_null() {
        return r#"{"error":"no_wdm_inst"}"#.to_string();
    }
    let sm_class = find_class(
        image,
        to_cstr("Gallop").as_ptr(),
        to_cstr("WorkSingleModeData").as_ptr(),
    );
    if sm_class.is_null() {
        return r#"{"error":"no_sm_class"}"#.to_string();
    }
    let sm_obj = call_getter_ref(wdm_class, wdm_inst, "get_SingleMode");
    if sm_obj.is_null() {
        return r#"{"error":"no_sm"}"#.to_string();
    }
    let chara_class = find_class(
        image,
        to_cstr("Gallop").as_ptr(),
        to_cstr("WorkSingleModeCharaData").as_ptr(),
    );
    if chara_class.is_null() {
        return r#"{"error":"no_chara_class"}"#.to_string();
    }
    let chara_obj = call_getter_ref(sm_class, sm_obj, "get_Character");
    if chara_obj.is_null() {
        return r#"{"error":"no_chara"}"#.to_string();
    }

    let via_getter = call_getter_on_instance(chara_class, chara_obj, "get_SkillTipsList");
    let via_field = read_ptr_at(chara_obj, 696);
    let acquired = read_ptr_at(chara_obj, 680);

    let mut elem_class_json = String::from("null");
    let mut elem_hex = String::from("");
    for l in [via_getter, via_field] {
        let elems = walk_obj_list(l);
        if let Some(e) = elems.first() {
            let ec = get_class_from_object(*e);
            if !ec.is_null() {
                elem_class_json = enumerate_class_fields(ec);
                let mut hx = String::new();
                for k in 0..16 {
                    hx.push_str(&format!(
                        "{:02x}",
                        std::ptr::read_unaligned::<u8>((*e as *const u8).add(k))
                    ));
                }
                elem_hex = hx;
                break;
            }
        }
    }

    let cache_len = SKILL_TIPS_GROUPS.lock().map(|g| g.len()).unwrap_or(0);
    format!(
        r#"{{"hook_installed":{},"hook_hits":{},"getter_addr":"0x{:x}","hook_list_ptr":"0x{:x}","hook_cache_len":{},"via_getter":{},"via_field":{},"acquired_list":{{"ptr":"0x{:x}","count":{}}},"elem_class_fields":{},"elem_hex":"{}","skill_model":{}}}"#,
        SKILL_TIPS_HOOK_INSTALLED.load(Ordering::Relaxed),
        SKILL_TIPS_HOOK_HITS.load(Ordering::Relaxed),
        SKILL_TIPS_GETTER_ADDR.load(Ordering::Relaxed),
        SKILL_TIPS_LIST_PTR.lock().map(|p| *p).unwrap_or(0),
        cache_len,
        tips_list_json(via_getter),
        tips_list_json(via_field),
        acquired as usize,
        list_count_of(acquired),
        elem_class_json,
        elem_hex,
        skill_model_json()
    )
}

`;
once('// ★ v3.24.9: Training result hook — rewritten to use interceptor API', CODE + '// ★ v3.24.9: Training result hook — rewritten to use interceptor API');

// ---------- 2) 重写 read_skill_tips ----------
const startMark = 'unsafe fn read_skill_tips(';
const endMark = '/// Compute skill evaluation from learned skills using MasterDB';
const i = s.indexOf(startMark);
const j = s.indexOf(endMark);
if (i < 0 || j < 0 || j < i) throw new Error('read_skill_tips block not found');
const NEWFN = `unsafe fn read_skill_tips(
    chara_class: *mut c_void,
    chara_obj: *const c_void,
    _image: *const c_void,
) -> Vec<(i32, i32, i32)> {
    // [SKILLHOOK-3292] 元素类型是 List<Gallop.WorkSingleModeCharaData/SkillTips>（嵌套类），
    // 嵌套类字段布局与 Gallop.SkillTips 不同 → 旧硬偏移 16/36/56 全解码成 0 → 列表"看起来是空的"。
    // 现在按元素运行时类的字段名取偏移，raw 偏移只兜底。
    let via_getter = call_getter_on_instance(chara_class, chara_obj, "get_SkillTipsList");
    for l in [via_getter, read_ptr_at(chara_obj, 696)] {
        let decoded = decode_skill_tips_list(l);
        if !decoded.is_empty() {
            return decoded;
        }
    }
    // 兜底：游戏自己取过一次（hook 缓存）
    SKILL_TIPS_GROUPS
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default()
}

`;
s = s.slice(0, i) + NEWFN + s.slice(j);

// ---------- 3) /summary 里 tips 走缓存兜底 ----------
once(
  'let tips = read_skill_tips(chara_class, chara_obj, image);',
  `let mut tips = read_skill_tips(chara_class, chara_obj, image);
        if tips.is_empty() {
            if let Ok(g) = SKILL_TIPS_GROUPS.lock() {
                tips = g.clone();
            }
        }`
);

// ---------- 4) 注册诊断端点 ----------
once(
  '    } else if path == "/debug/hookdiag" {',
  `    } else if path == "/debug/skilltips_probe" {
        // [SKILLHOOK-3292] 技能提示诊断：getter / 字段 / hook 缓存
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
            debug_skilltips_probe()
        }))
        .unwrap_or_else(|_| r#"{"error":"skilltips_probe_panic"}"#.to_string())
    } else if path == "/debug/hookdiag" {`
);

// ---------- 5) 挂 hook（3 个 install 站点） ----------
const n = s.split('install_event_choice_hook();').length - 1;
if (n !== 3) throw new Error('install sites=' + n);
const INS = [
  'install_event_choice_hook();',
  '                install_skill_tips_hook();',
  '                install_skill_model_hook();'
].join(String.fromCharCode(10));
s = s.split('install_event_choice_hook();').join(INS);

fs.writeFileSync(P, s);
console.log('skillhook applied');