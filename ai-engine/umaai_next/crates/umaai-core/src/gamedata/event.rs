//! 事件数据（events.json）的纯 schema/DTO
//!
//! 含选项数值、触发类型与状态增减。人读形态分两层：纯文本 [`fmt::Display`]
//! （平台无关的值形态）在本层，富呈现（着色 / 表格）归 `umaai-cli`；
//! 依赖全局数据的语义构造（红点 / 加练事件）归 `umasim`。

use std::collections::BTreeMap;
use std::fmt;

use int_enum::IntEnum;
use serde::{Deserialize, Serialize};

use crate::{Array6, Data, flags::UmaFlags};

/// 事件触发类型
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TriggerType {
    /// 随机事件，任意回合可触发
    Random {
        /// 最大触发次数，0 为无限
        #[serde(default)]
        max_time: u32,
    },
    /// 代码生成的临时事件，不会自行触发（默认）
    #[default]
    Code,
    /// 固定回合触发
    Fixed {
        /// 触发回合列表
        turns: Vec<i32>,
    },
}

/// 训练或事件的数值
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ActionValue {
    /// 基础属性（速 / 耐 / 力 / 根 / 智 / pt）
    #[serde(default)]
    pub status_pt: Array6,
    /// 体力
    #[serde(default)]
    pub vital: i32,
    /// 最大体力
    #[serde(default)]
    pub max_vital: i32,
    /// 干劲
    #[serde(default)]
    pub motivation: i32,
    /// Hint 等级
    #[serde(default)]
    pub hint_level: i32,
    /// 羁绊
    #[serde(default)]
    pub friendship: i32,
}

impl ActionValue {
    /// 对五维属性与 pt 做映射（如事件效果提高时的全体倍率）
    pub fn map_status<F>(&mut self, f: F) -> &mut Self
    where
        F: Fn(i32) -> i32,
    {
        for x in self.status_pt.iter_mut() {
            *x = f(*x);
        }
        self
    }
}

impl fmt::Display for ActionValue {
    /// 紧凑增减摘要：`速+12 PT+7 体-20 羁绊+7`（零字段省略，全零为空串）
    ///
    /// 轴名取静态数据（不在代码里写第二份）；数据未载入时退化为下标（`#0+12`）。
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut parts: Vec<String> = vec![];
        for (i, value) in self.status_pt.iter().enumerate().take(5) {
            if *value != 0 {
                parts.push(format!("{}{value:+}", axis_name(i)));
            }
        }
        if self.status_pt[5] != 0 {
            parts.push(format!("PT{:+}", self.status_pt[5]));
        }
        if self.vital != 0 {
            parts.push(format!("体{:+}", self.vital));
        }
        if self.max_vital != 0 {
            parts.push(format!("体上限{:+}", self.max_vital));
        }
        if self.motivation != 0 {
            parts.push(format!("干{:+}", self.motivation));
        }
        if self.hint_level != 0 {
            parts.push(format!("红点{:+}", self.hint_level));
        }
        if self.friendship != 0 {
            parts.push(format!("羁绊{:+}", self.friendship));
        }
        f.write_str(&parts.join(" "))
    }
}

/// 训练轴名：经 `super::GameConstants::train_name`（唯一出口），未载入退化为下标
fn axis_name(i: usize) -> String {
    Data::try_get().map_or_else(|| format!("#{i}"), |d| d.consts.train_name(i))
}

/// 结算时才确定目标的属性获得（固定值见 [`ActionValue::status_pt`]）
///
/// 旧实现对这类效果做平均化近似（如「随机 1 项 +10」写成五维各 +2 / +3），
/// 这里显式表达；`value` 参与 [`EventChoice::map_status`] 的同一乘算（比赛加成等）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExtraStatus {
    /// 随机 `count` 项五维各 +`value`（等概率、不重复；1 ≤ count ≤ 5）
    Random {
        /// 抽取的属性项数
        count: u8,
        /// 每项增量
        value: i32,
    },
    /// 上一次训练的对应五维 +`value`（无上一次训练时忽略）
    LastTrain {
        /// 增量
        value: i32,
    },
}

impl ExtraStatus {
    /// 对增量做映射（与 `ActionValue::map_status` 同口径的乘算）
    pub fn map_value<F>(&mut self, f: F) -> &mut Self
    where
        F: Fn(i32) -> i32,
    {
        match self {
            Self::Random { value, .. } | Self::LastTrain { value } => *value = f(*value),
        }
        self
    }
}

impl fmt::Display for ExtraStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Random { count, value } => write!(f, "随机{count}项{value:+}"),
            Self::LastTrain { value } => write!(f, "上次训练{value:+}"),
        }
    }
}

/// 事件选项结果
#[repr(i32)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, IntEnum)]
pub enum ChoiceResult {
    /// 普通
    #[default]
    Normal = 0,
    /// 成功
    Success = 1,
    /// 大成功
    BigSuccess = 2,
    /// 失败
    Fail = 3,
    /// 大失败
    BigFail = 4,
}

/// 事件选项的某一个可能结果
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct EventChoice {
    /// 选项结果，可转为 [`ChoiceResult`]
    #[serde(default)]
    pub result: i32,
    /// 出现概率（0 为默认，100 为必定触发）
    #[serde(default)]
    pub prob: i32,
    /// 效果
    #[serde(default)]
    pub value: ActionValue,
    /// 结算时才确定目标的额外属性（随机 / 上次训练）；`None` = 无
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_status: Option<ExtraStatus>,
    /// 添加的状态
    #[serde(default)]
    pub add_flags: Option<UmaFlags>,
    /// 移除的状态
    #[serde(default)]
    pub remove_flags: Option<UmaFlags>,
}

impl EventChoice {
    /// 由数值与结果类型构造（概率取必定触发）
    pub fn from_action_value(value: &ActionValue, result: ChoiceResult) -> Self {
        Self {
            result: result as i32,
            prob: 100,
            value: value.clone(),
            extra_status: None,
            add_flags: None,
            remove_flags: None,
        }
    }

    /// 对五维属性与 pt 做映射（固定值与 [`ExtraStatus`] 增量一起）
    pub fn map_status<F>(&mut self, f: F) -> &mut Self
    where
        F: Fn(i32) -> i32,
    {
        self.value.map_status(&f);
        if let Some(extra) = &mut self.extra_status {
            extra.map_value(f);
        }
        self
    }
}

/// 事件数据
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct EventData {
    /// 事件 ID
    pub id: u32,
    /// 事件名
    pub name: String,
    /// 关联人头（羁绊归属；计算时随机指定，不在数据里）
    #[serde(default)]
    pub person_index: Option<i32>,
    /// 触发类型
    #[serde(default)]
    pub trigger: TriggerType,
    /// 选项是否可玩家选择
    #[serde(default)]
    pub player_select: bool,
    /// 选项组：每组内含多个带概率的结果
    #[serde(default)]
    pub choices: Vec<Vec<EventChoice>>,
}

impl EventData {
    /// 第一个选项组的首个结果；无选项时 `None`
    pub fn default_choice(&self) -> Option<&EventChoice> {
        self.choices.first().and_then(|g| g.first())
    }

    /// 对全部选项的五维属性与 pt 做映射
    pub fn map_status<F>(&mut self, f: F) -> &mut Self
    where
        F: Fn(i32) -> i32,
    {
        for group in self.choices.iter_mut() {
            for choice in group.iter_mut() {
                choice.map_status(&f);
            }
        }
        self
    }

    /// 由数值构造单选项事件
    pub fn from_action_value(id: u32, name: &str, value: &ActionValue) -> Self {
        Self {
            id,
            name: name.to_string(),
            choices: vec![vec![EventChoice::from_action_value(value, ChoiceResult::Success)]],
            ..Default::default()
        }
    }
}

/// 事件数据表
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct EventCollection {
    /// 剧本必发事件
    pub story_events: Vec<EventData>,
    /// 马娘正面事件
    pub uma_events: Vec<EventData>,
    /// 支援卡连续事件
    pub card_events: Vec<EventData>,
    /// 友人事件
    pub friend_events: BTreeMap<String, EventData>,
    /// 系统事件
    pub system_events: BTreeMap<String, EventData>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 层1：触发类型按 `type` 标签解析，缺省为代码事件
    #[test]
    fn test_trigger_type() {
        let r: TriggerType = serde_json::from_str(r#"{"type": "Random", "max_time": 3}"#).unwrap();
        assert_eq!(r, TriggerType::Random { max_time: 3 });
        let c: TriggerType = serde_json::from_str(r#"{"type": "Code"}"#).unwrap();
        assert_eq!(c, TriggerType::Code);
        let f: TriggerType = serde_json::from_str(r#"{"type": "Fixed", "turns": [11, 12]}"#).unwrap();
        assert_eq!(f, TriggerType::Fixed { turns: vec![11, 12] });
        assert_eq!(TriggerType::default(), TriggerType::Code);
    }

    /// 层1：随机 / 上次训练属性效果可解析且缺省为空；未知 kind 报错
    #[test]
    fn test_extra_status_schema() {
        let c: EventChoice =
            serde_json::from_str(r#"{"extra_status": {"kind": "random", "count": 1, "value": 10}}"#).unwrap();
        assert_eq!(c.extra_status, Some(ExtraStatus::Random { count: 1, value: 10 }));
        let c: EventChoice = serde_json::from_str(r#"{"extra_status": {"kind": "last_train", "value": 20}}"#).unwrap();
        assert_eq!(c.extra_status, Some(ExtraStatus::LastTrain { value: 20 }));
        let c: EventChoice = serde_json::from_str("{}").unwrap();
        assert_eq!(c.extra_status, None);
        assert!(
            serde_json::from_str::<EventChoice>(r#"{"extra_status": {"kind": "nope"}}"#).is_err(),
            "未知 kind 应报错"
        );
    }

    /// 层1：`map_status` 同时缩放固定值与额外属性增量（比赛加成对随机项也生效）
    #[test]
    fn test_extra_status_map_value() {
        let mut c = EventChoice::from_action_value(&ActionValue::default(), ChoiceResult::Success);
        c.extra_status = Some(ExtraStatus::Random { count: 1, value: 10 });
        c.map_status(|x| x * 3 / 2);
        assert_eq!(c.extra_status, Some(ExtraStatus::Random { count: 1, value: 15 }));
        assert_eq!(c.extra_status.unwrap().to_string(), "随机1项+15");
    }

    /// 层1：选项结果与 `ChoiceResult` 双向一致
    #[test]
    fn test_choice_result() {
        let c: EventChoice = serde_json::from_str(r#"{"result": 2, "prob": 40}"#).unwrap();
        assert_eq!(ChoiceResult::try_from(c.result).unwrap(), ChoiceResult::BigSuccess);
        assert_eq!(c.prob, 40);
        let made = EventChoice::from_action_value(&ActionValue::default(), ChoiceResult::Success);
        assert_eq!(made.result, ChoiceResult::Success as i32);
        assert_eq!(made.prob, 100);
    }

    /// 层1：数值纯文本摘要——零字段省略、全零为空串、字段次序固定
    #[test]
    fn test_action_value_display() {
        // 轴名是否可取决于全局数据是否已载入（同进程其它测试可能已 init），
        // 两种形态都合法：具名（数据在）或下标（数据不在），断言自适应两者
        let named = Data::try_get().is_some();
        let v = ActionValue {
            status_pt: [12, 0, 0, 0, 0, 7],
            vital: -20,
            motivation: 1,
            friendship: 7,
            ..ActionValue::default()
        };
        let want = if named {
            "速+12 PT+7 体-20 干+1 羁绊+7"
        } else {
            "#0+12 PT+7 体-20 干+1 羁绊+7"
        };
        assert_eq!(v.to_string(), want);
        assert_eq!(ActionValue::default().to_string(), "");
    }

    /// 层1：缺省字段补齐、空选项组不 panic
    #[test]
    fn test_defaults_and_empty_choices() {
        let e: EventData = serde_json::from_str(r#"{"id": 1, "name": "x"}"#).unwrap();
        assert_eq!(e.trigger, TriggerType::Code);
        assert!(!e.player_select);
        assert!(e.choices.is_empty());
        assert!(e.default_choice().is_none());
    }

    /// 层1：事件表五个分区的键名与数据结构
    #[test]
    fn test_collection_shape() {
        let raw = r#"{"story_events": [{"id": 1, "name": "s"}], "uma_events": [], "card_events": [],
                      "friend_events": {"k": {"id": 2, "name": "f"}}, "system_events": {"extra_train": {"id": 3, "name": "t"}}}"#;
        let c: EventCollection = serde_json::from_str(raw).unwrap();
        assert_eq!(c.story_events.len(), 1);
        assert_eq!(c.friend_events["k"].id, 2);
        assert_eq!(c.system_events["extra_train"].id, 3);
    }
}
