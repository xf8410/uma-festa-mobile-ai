//! 终局帧（`game{id}_finalScore.json`）：育成结束、点技能前的真机终局数据
//!
//! 终局帧与回合帧走**同一目录**，靠**文件名**区分（[`FrameKind::FinalScore`](super::channel::FrameKind)）；
//! payload 是**扁平**结构（没有 `baseGame` 外壳），字段名沿用回合帧命名。它不进决策链路，
//! 只用于终局核对与归档。
//!
//! 三道闸（旧实现在线记录链路逐条踩过，勿简化）：
//!
//! 1. **契约必填**：五维 / 五维上限 / 剩余技能点缺一即解析失败——插件字段漂移要炸出声，
//!    不能静默按 0 打分；缺失可容忍的字段一律带 serde 默认值。
//! 2. **数值可用**：[`FinalScoreFrame::is_usable`] 拒绝「字段在场但全 0」的坏帧
//!    （放行会让五维分整体清零，却仍被当成真机终局）。
//! 3. **局号匹配**：同目录会积着多局的终局帧（文件名带局号），由调用方用
//!    [`FinalScoreFrame::epoch_key`] 与当前局号比对，不匹配即忽略。
//!
//! 剧本过滤不在本层：帧内 `scenario_id` 原样保留，是否接受由宿主注入的剧本档案判定。
//!
//! **动作序列（E2）**：新帧带 `actionSchemaVersion` + `actions`（玩家实际动作，259 条量级）。
//! 它是**复盘材料**，不进决策链路、不影响任何一道闸；字段随批次演进，端点私有键用
//! `#[serde(flatten)]` 原样收进 [`FinalAction::fields`]，引擎不解释。

use anyhow::Result;
use serde::{Deserialize, Serialize};
use umaai_core::{Array5, Data};
use umasim::game::Uma;

/// 终局帧（扁平结构）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalScoreFrame {
    /// 剧本 ID（引擎不解释）
    pub scenario_id: u32,
    /// 育成局号（单调递增；缺字段时调用方应忽略该帧）
    #[serde(default, rename = "single_mode_chara_id")]
    pub single_mode_chara_id: Option<u64>,
    /// 马娘 ID
    #[serde(default)]
    pub uma_id: u32,
    /// 马娘星数
    #[serde(default)]
    pub uma_star: u32,
    /// 回合（0 基，终局帧为末回合）
    #[serde(default)]
    pub turn: i32,
    /// 客户端育成状态（2 / 3 = 结束态）
    #[serde(default)]
    pub state: i32,
    /// 客户端回合状态
    #[serde(default, rename = "playing_state")]
    pub playing_state: i32,
    /// 终局五维（契约必填）
    pub five_status: Array5,
    /// 五维上限（契约必填）
    pub five_status_limit: Array5,
    /// 点技能前的剩余技能点（契约必填）
    pub skill_pt: i32,
    /// 总 Hint 等级
    #[serde(default)]
    pub total_hints: i32,
    /// 本局累计花掉的技能点
    #[serde(default)]
    pub skill_pt_spent: i32,
    /// 继承属性增量（仅复盘分析用）
    #[serde(default, rename = "inheritGains")]
    pub inherit_gains: Vec<i32>,
    /// 动作 schema 版本（缺字段 = 旧帧，无 `actions`）
    #[serde(default)]
    pub action_schema_version: Option<u32>,
    /// 玩家实际动作序列（旧帧为 `None`；只进 DTO，不进决策链路）
    #[serde(default)]
    pub actions: Option<Vec<FinalAction>>,
}

/// 一条玩家实际动作（终局帧附带）
///
/// 端点私有字段按 `actionSchemaVersion` 演进（`exec_command` 带 `command_type / command_id /
/// select_id / current_vital`，`check_event` 带 `event_id / chara_id / choice_number`…），
/// 引擎不解释，原样收进 [`Self::fields`]。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FinalAction {
    /// 动作发生的回合（0 基）
    pub turn: i32,
    /// 端点名（`exec_command` / `check_event` 等）
    pub endpoint: String,
    /// 端点私有字段（原样保留，键随批次变化）
    #[serde(flatten)]
    pub fields: serde_json::Map<String, serde_json::Value>,
}

impl FinalScoreFrame {
    /// 解析帧原文
    pub fn parse(frame: &str) -> Result<Self> {
        Ok(serde_json::from_str(frame)?)
    }

    /// 局号（`None` = 帧内缺字段，调用方应忽略该帧）
    pub fn epoch_key(&self) -> Option<u64> {
        self.single_mode_chara_id
    }

    /// 局号是否属于当前这一局（防上一局残留帧）
    pub fn matches_epoch(&self, current: u64) -> bool {
        self.epoch_key() == Some(current)
    }

    /// 帧内容是否可用：五维与五维上限不得全零
    pub fn is_usable(&self) -> bool {
        self.five_status.iter().any(|v| *v > 0) && self.five_status_limit.iter().any(|v| *v > 0)
    }

    /// 终局评分（与模拟同源：五维查表 + PT 折算）
    ///
    /// 本通道不带已学技能分，切者 / 小切的 PT 折算标志也不在帧内，故是「点技能前」
    /// 的口径，略低于游戏最终分。
    pub fn calc_score(&self) -> Result<i32> {
        Uma {
            five_status: self.five_status,
            five_status_limit: self.five_status_limit,
            skill_pt: self.skill_pt,
            skill_score: 0,
            total_hints: self.total_hints,
            ..Default::default()
        }
        .calc_score()
    }

    /// 终局评分对应的档次名
    pub fn rank_name(&self) -> Result<String> {
        Ok(Data::get()?.consts.get_rank_name(self.calc_score()?).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(five: Array5, limit: Array5) -> FinalScoreFrame {
        FinalScoreFrame {
            scenario_id: 1,
            single_mode_chara_id: Some(7),
            uma_id: 101901,
            uma_star: 4,
            turn: 77,
            state: 3,
            playing_state: 5,
            five_status: five,
            five_status_limit: limit,
            skill_pt: 100,
            total_hints: 10,
            skill_pt_spent: 0,
            inherit_gains: vec![],
            action_schema_version: None,
            actions: None,
        }
    }

    /// 层1：契约必填字段缺失 → 解析失败
    #[test]
    fn test_required_fields() {
        let full = r#"{"scenarioId":1,"umaId":1,"turn":77,"fiveStatus":[100,0,0,0,0],
            "fiveStatusLimit":[200,0,0,0,0],"skillPt":100}"#;
        assert!(FinalScoreFrame::parse(full).is_ok(), "契约字段齐全应可解析");

        let no_five = r#"{"scenarioId":1,"umaId":1,"turn":77,"fiveStatusLimit":[200,0,0,0,0],"skillPt":100}"#;
        let no_limit = r#"{"scenarioId":1,"umaId":1,"turn":77,"fiveStatus":[100,0,0,0,0],"skillPt":100}"#;
        let no_pt =
            r#"{"scenarioId":1,"umaId":1,"turn":77,"fiveStatus":[100,0,0,0,0],"fiveStatusLimit":[200,0,0,0,0]}"#;
        for (name, raw) in [
            ("fiveStatus", no_five),
            ("fiveStatusLimit", no_limit),
            ("skillPt", no_pt),
        ] {
            assert!(FinalScoreFrame::parse(raw).is_err(), "缺 {name} 应报错");
        }
    }

    /// 层1：全零坏帧判不可用
    #[test]
    fn test_usable() {
        assert!(!frame([0; 5], [0; 5]).is_usable(), "五维与上限全零 → 不可用");
        assert!(!frame([100, 0, 0, 0, 0], [0; 5]).is_usable(), "上限全零 → 不可用");
        assert!(frame([100, 0, 0, 0, 0], [200, 0, 0, 0, 0]).is_usable());
    }

    /// 层1：局号匹配
    #[test]
    fn test_epoch() {
        let mut f = frame([100, 0, 0, 0, 0], [200, 0, 0, 0, 0]);
        assert!(f.matches_epoch(7));
        assert!(!f.matches_epoch(8), "上一局残留帧不得匹配");
        f.single_mode_chara_id = None;
        assert_eq!(f.epoch_key(), None);
        assert!(!f.matches_epoch(7));
    }

    /// 层1：旧帧无 `actions` → `None`；新帧解析出动作序列，端点私有字段原样保留
    #[test]
    fn test_actions() {
        let old = r#"{"scenarioId":15,"single_mode_chara_id":6310,"turn":77,
            "fiveStatus":[100,0,0,0,0],"fiveStatusLimit":[200,0,0,0,0],"skillPt":100}"#;
        let old_frame = FinalScoreFrame::parse(old).expect("旧帧应可解析");
        assert_eq!(old_frame.action_schema_version, None);
        assert_eq!(old_frame.actions, None);

        let new = r#"{"scenarioId":15,"single_mode_chara_id":6310,"turn":77,
            "fiveStatus":[100,0,0,0,0],"fiveStatusLimit":[200,0,0,0,0],"skillPt":100,
            "actionSchemaVersion":1,
            "actions":[
              {"turn":12,"endpoint":"exec_command","command_type":1,"command_id":5101,"current_vital":80},
              {"turn":12,"endpoint":"check_event","event_id":20099,"choice_number":0}
            ]}"#;
        let new_frame = FinalScoreFrame::parse(new).expect("新帧应可解析");
        assert_eq!(new_frame.action_schema_version, Some(1));
        let actions = new_frame.actions.as_ref().expect("应带动作序列");
        assert_eq!(actions.len(), 2, "动作条数");
        assert_eq!(actions[0].endpoint, "exec_command");
        assert_eq!(actions[0].turn, 12);
        assert_eq!(
            actions[0].fields.get("command_id").and_then(|v| v.as_i64()),
            Some(5101),
            "端点私有字段原样保留"
        );
        assert_eq!(actions[1].endpoint, "check_event");
        // 三道闸不受影响：同一份新帧的可用性 / 局号判定与旧帧同口径
        assert!(new_frame.is_usable());
        assert!(new_frame.matches_epoch(6310));
        assert!(!new_frame.matches_epoch(6309));
    }
}
