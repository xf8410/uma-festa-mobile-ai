//! 国服（com.bilibili.umamusume 2.0.5）版 /summary —— workbench/cn-ura
//!
//! 结构依据：uma-il2cpp-metadata/docs/CN-PLUGIN-ADAPTATION.md（2026-11-12 符号全量核对）
//! 国服 ≈ 日服 2022 初结构：训练走 WorkSingleModeHomeInfo 老路；字段偏移与日服完全不同，
//! 因此**全部数据走 getter 调用 / field-by-name 运行时查偏移**，零硬编码偏移（对版本更新鲁棒）。
//! 输出 schema 与日服 6498 行模板逐字段对齐（festa App NativeEngine 无改动接收）。

use std::ffi::c_void;
use super::*;

/// 场景名（国服已开 7 个剧本；日服 8+ 的分支不发）
fn cn_scenario_name(sid: i32) -> &'static str {
    match sid {
        1 => "URA",
        2 => "TeamRace",
        3 => "Live",
        4 => "Free",
        5 => "Venus",
        6 => "Arc",
        7 => "Sport",
        _ => "Unknown",
    }
}

fn mot_name(m: i32) -> &'static str {
    match m {
        5 => "Best",
        4 => "Good",
        3 => "Normal",
        2 => "Bad",
        1 => "Worst",
        _ => "?",
    }
}

/// field-by-name：运行时查字段偏移（偏移无关，对国服结构更新鲁棒）
unsafe fn cn_field_offset(class: *mut c_void, name: &str) -> i32 {
    let f = match (*API).il2cpp_get_field_from_name_fn {
        Some(f) => f(class, to_cstr(name).as_ptr()),
        None => return -1,
    };
    if f.is_null() {
        return -1;
    }
    (*(f as *const Il2CppFieldInfo)).offset
}

/// 读 int 字段（plain Int32 假设；越界哨兵返回 -1）
unsafe fn cn_read_int_field(obj: *const c_void, off: i32) -> i32 {
    if obj.is_null() || off < 0 {
        return -1;
    }
    std::ptr::read_unaligned::<i32>(obj.add(off as usize) as *const i32)
}

pub unsafe fn read_summary_cn() -> String {
    let image = get_image();
    if image.is_null() {
        return r#"{"ok":false,"error":"no_image"}"#.to_string();
    }
    // ── 对象链：WorkDataManager → get_SingleMode → get_Character / get_HomeInfo ──
    let wdm_class = find_class(image, to_cstr("Gallop").as_ptr(), to_cstr("WorkDataManager").as_ptr());
    if wdm_class.is_null() {
        return r#"{"ok":false,"error":"no_wdm_class"}"#.to_string();
    }
    let wdm = get_singleton(wdm_class);
    if wdm.is_null() {
        return r#"{"ok":false,"error":"no_wdm_singleton","note":"not_in_training"}"#.to_string();
    }
    let sm_class = find_class(image, to_cstr("Gallop").as_ptr(), to_cstr("WorkSingleModeData").as_ptr());
    let sm_obj = call_getter_ref(wdm_class, wdm, "get_SingleMode");
    if sm_class.is_null() || sm_obj.is_null() {
        return r#"{"ok":false,"error":"no_single_mode"}"#.to_string();
    }
    let chara_class = find_class(image, to_cstr("Gallop").as_ptr(), to_cstr("WorkSingleModeCharaData").as_ptr());
    let chara_obj = call_getter_ref(sm_class, sm_obj, "get_Character");
    if chara_class.is_null() || chara_obj.is_null() {
        return r#"{"ok":false,"error":"no_character"}"#.to_string();
    }

    // ── stats：74 getter 全按名调用（ObscuredInt 解码走日服同款设施）──
    let spd = call_getter_obscured_int(chara_class, chara_obj, "get_Speed");
    let sta = call_getter_obscured_int(chara_class, chara_obj, "get_Stamina");
    let pow_ = call_getter_obscured_int(chara_class, chara_obj, "get_Power");
    let gut = call_getter_obscured_int(chara_class, chara_obj, "get_Guts");
    let wiz = call_getter_obscured_int(chara_class, chara_obj, "get_Wiz");
    let vit = call_getter_obscured_int(chara_class, chara_obj, "get_Hp");
    let mvit = call_getter_obscured_int(chara_class, chara_obj, "get_MaxHp");
    let mot = call_getter_obscured_int(chara_class, chara_obj, "get_Motivation");
    let spt = call_getter_obscured_int(chara_class, chara_obj, "get_SkillPoint");
    let fan = call_getter_obscured_int(chara_class, chara_obj, "get_FanCount");
    let chara_id = call_getter_obscured_int(chara_class, chara_obj, "get_CharaId");
    let sid = call_getter_obscured_int(chara_class, chara_obj, "get_ScenarioId");
    let scn_prog = call_getter_obscured_int(chara_class, chara_obj, "get_ScenarioProgress");
    let training_event_type = call_getter_obscured_int(chara_class, chara_obj, "get_TrainingEventType");
    let talent_level = call_getter_obscured_int(chara_class, chara_obj, "get_TalentLevel");
    let chara_grade = call_getter_obscured_int(chara_class, chara_obj, "get_CharaGrade");
    let difficulty = call_getter_obscured_int(chara_class, chara_obj, "get_Difficulty");
    let running_style = call_getter_obscured_int(chara_class, chara_obj, "get_RunningStyle");

    let max_spd = call_getter_obscured_int(chara_class, chara_obj, "get_MaxSpeed");
    let max_sta = call_getter_obscured_int(chara_class, chara_obj, "get_MaxStamina");
    let max_pow = call_getter_obscured_int(chara_class, chara_obj, "get_MaxPower");
    let max_gut = call_getter_obscured_int(chara_class, chara_obj, "get_MaxGuts");
    let max_wiz = call_getter_obscured_int(chara_class, chara_obj, "get_MaxWiz");

    // 适性 10 项
    let pds = call_getter_obscured_int(chara_class, chara_obj, "get_ProperDistanceShort");
    let pdm = call_getter_obscured_int(chara_class, chara_obj, "get_ProperDistanceMile");
    let pdmid = call_getter_obscured_int(chara_class, chara_obj, "get_ProperDistanceMiddle");
    let pdl = call_getter_obscured_int(chara_class, chara_obj, "get_ProperDistanceLong");
    let pgt = call_getter_obscured_int(chara_class, chara_obj, "get_ProperGroundTurf");
    let pgd = call_getter_obscured_int(chara_class, chara_obj, "get_ProperGroundDirt");
    let psn = call_getter_obscured_int(chara_class, chara_obj, "get_ProperRunningStyleNige");
    let pss = call_getter_obscured_int(chara_class, chara_obj, "get_ProperRunningStyleSenko");
    let psa = call_getter_obscured_int(chara_class, chara_obj, "get_ProperRunningStyleSashi");
    let pso = call_getter_obscured_int(chara_class, chara_obj, "get_ProperRunningStyleOikomi");

    // ── 回合：month/half 走 getter；turn 走 field-by-name（国服无 totalTurnNum 偏移语义核对）──
    let mon = call_getter_int(sm_class, sm_obj, "get_Month");
    let half = call_getter_int(sm_class, sm_obj, "get_Half");
    let playing_state = call_getter_int(sm_class, sm_obj, "get_PlayingState");

    // turn 字段双读法探测（plain / ObscuredInt；合理域 1..=78）
    let turn_off = cn_field_offset(sm_class, "turn");
    let turn_plain = cn_read_int_field(sm_obj, turn_off);
    let turn_obs = if turn_off >= 0 {
        read_obscured_int_at(sm_obj, turn_off)
    } else {
        -1
    };
    let (turn, turn_raw_probe) = if (1..=78).contains(&turn_plain) {
        (turn_plain, turn_obs)
    } else if (1..=78).contains(&turn_obs) {
        (turn_obs, turn_plain)
    } else {
        (-1, turn_plain)
    };
    // year：国服无 year 字段/getter —— 由 turn 推算（每游戏年 24 半回合；URA 段 73-78）
    let year = if turn >= 1 {
        ((turn - 1) / 24) + 1
    } else {
        -1
    };

    // ── buffs / chara_effects / skills（结构细节迭代；骨架先 len + id 流）──
    // charaEffectIdArray：日服为 List<int>，国服同 getter（get_CharaEffectIdArray）
    let effects_arr = call_getter_ref(chara_class, chara_obj, "get_CharaEffectIdArray");
    let effect_ids: Vec<String> = if !effects_arr.is_null() {
        read_il2cpp_int_list(effects_arr)
            .iter()
            .map(|v| v.to_string())
            .collect()
    } else {
        Vec::new()
    };

    // AcquiredSkillList：len 骨架
    let skills_arr = call_getter_ref(chara_class, chara_obj, "get_AcquiredSkillList");
    let skill_count = if !skills_arr.is_null() {
        read_il2cpp_int_list(skills_arr).len()
    } else {
        0
    };

    // ── 支援卡：EquipSupportCardArray → len 骨架（card_id 字段结构迭代）──
    let esc_arr = call_getter_ref(chara_class, chara_obj, "get_EquipSupportCardArray");
    let esc_len = if !esc_arr.is_null() {
        let base = esc_arr as *const u8;
        std::ptr::read_unaligned::<usize>(base.add(IL2CPP_LIST_COUNT_OFF) as *const usize) as i32
    } else {
        0
    };

    // ── trainings：国服老结构 WorkSingleModeHomeInfo（骨架空数组；细节按 GetTrainingCommandTurnInfos 迭代）──
    let _home_info = call_getter_ref(sm_class, sm_obj, "get_HomeInfo");

    format!(
        r#"{{"ok":true,"version":"{}-cn","year":{},"turn":{},"raw_total_turn_num":{},"turn_probe_plain":{},"ui_turn_semantics":"countdown","raw_field_mapping":"cn_2022_structure","month":{},"half":{},"scenario":"{}","chara_id":{},"playing_state":{},"stats":{{"speed":{},"stamina":{},"power":{},"guts":{},"wiz":{},"vital":{},"max_vital":{},"motivation":"{}","skill_point":{},"fan":{}}},"max_stats":{{"speed":{},"stamina":{},"power":{},"guts":{},"wiz":{}}},"proper":{{"dist_short":{},"dist_mile":{},"dist_mid":{},"dist_long":{},"ground_turf":{},"ground_dirt":{},"style_nige":{},"style_senko":{},"style_sashi":{},"style_oikomi":{}}},"running_style":{},"scenario_progress":{},"training_event_type":{},"talent_level":{},"chara_grade":{},"difficulty":{},"fixed_turn_chara_seed":0,"trainings":[],"support_cards":{{"count":{}}},"evaluation":{{}},"training_levels":{{}},"buffs":[],"chara_effect_ids":[{}],"skills":{{"eval":0,"count":{},"list":[]}},"skill_tips":{{}}}}"#,
        PLUGIN_VERSION,
        year,
        turn,
        turn,
        turn_raw_probe,
        mon,
        half,
        cn_scenario_name(sid),
        chara_id,
        playing_state,
        spd, sta, pow_, gut, wiz, vit, mvit, mot_name(mot), spt, fan,
        max_spd, max_sta, max_pow, max_gut, max_wiz,
        pds, pdm, pdmid, pdl, pgt, pgd, psn, pss, psa, pso,
        running_style, scn_prog, training_event_type, talent_level, chara_grade, difficulty,
        esc_len,
        effect_ids.join(","),
        skill_count,
    )
}
