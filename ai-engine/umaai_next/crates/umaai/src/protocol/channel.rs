//! 帧通道：读 `.portable` 下小黑板插件写出的回合帧与终局帧
//!
//! 目录与文件名是**代码约定**（`.portable` / `PluginData/SendGameStatusPlugin` /
//! `thisTurn.json` / `game{id}_finalScore.json`），根目录由宿主注入——不做平台探测、不读环境变量。
//! 两条信道同形不同义，判别落在文件名上（[`FrameKind`]）：回合帧是**固定名**，
//! 终局帧按**局号命名**（每局一份、互不覆盖，旧局的终局帧不会被新局覆盖写掉）。
//!
//! 由此带来两处与「固定名」时代的差别：
//!
//! - **按文件名去重**：去重键是目录内的具体文件名，不是信道——新局写出
//!   `game6311_finalScore.json` 与旧局的 `game6310_finalScore.json` 是两份数据。
//! - **启动多候选取最新**：目录里可能积着多局的终局帧，启动兜底只推 mtime 最新的一份；
//!   其余旧局的终局帧不读（由调用方的局号闸再兜一层）。
//!
//! 旧固定名 `finalScore.json` **不再被识别**（[`FRAME_FINAL_SCORE`] 仅留常量兼容）。
//!
//! 错误分三层：目录缺失是**配置问题**，`FileChannel::open` 直接报错；通道关闭由
//! `FileChannel::next_frame` 报错；运行期瞬时问题（读到半截 / 文件被独占 / notify 事件
//! 错误）由通道**自愈**——丢本次事件等下一个写事件、notify 报错时重读全部白名单，并留一条
//! [`ChannelNote`] 痕迹供宿主取走。引擎不打印。
//!
//! 消费接口只提供带超时版本：`Ok(None)` = 这一拍没有新帧。
//!
//! **特性 `file-channel`（默认开）**：只有目录监听与稳定读（`FileChannel`）需要文件系统通知依赖；
//! 帧的形态（[`FrameKind`] / [`RawFrame`] / [`ChannelNote`] / [`plugin_dir`] 与文件名常量）常驻。
//! 下游自己喂帧时可关闭该特性，把 [`RawFrame`] 直接交给 `Session::step`。

use std::path::{Path, PathBuf};

#[cfg(feature = "file-channel")]
use std::{
    collections::HashMap,
    fs,
    sync::mpsc::{self, Receiver, RecvTimeoutError, Sender},
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime},
};

#[cfg(feature = "file-channel")]
use anyhow::{Context, Result, anyhow};
#[cfg(feature = "file-channel")]
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

/// `.portable` 目录名（游戏根目录下）
pub const PORTABLE_DIR: &str = ".portable";

/// 插件输出目录在 `.portable` 下的相对路径
pub const PLUGIN_SUBDIR: &str = "PluginData/SendGameStatusPlugin";

/// 回合帧文件名（AI 决策输入）
pub const FRAME_THIS_TURN: &str = "thisTurn.json";

/// 终局帧文件名后缀：`game{id}_finalScore.json`（前段为 `game` + 局号数字）
pub const FINAL_SCORE_SUFFIX: &str = "_finalScore.json";

/// 旧固定名终局帧：**已废弃，不参与匹配 / 读取**
///
/// E1 起终局帧按局号命名（[`FINAL_SCORE_SUFFIX`]）。本常量只为外部引用不炸，
/// 不要再用它拼路径——写了也不会被通道读到。
#[deprecated(note = "终局帧改为 `game{id}_finalScore.json`；本常量仅留兼容，不参与匹配")]
pub const FRAME_FINAL_SCORE: &str = LEGACY_FINAL_SCORE_NAME;

/// 旧固定名的字面量（内部用：`FrameKind::file_name` 的兼容返回值，绕开 deprecated 告警）
const LEGACY_FINAL_SCORE_NAME: &str = "finalScore.json";

/// 稳定读的重试次数与间隔（仅 `file-channel` 特性下使用）
#[cfg(feature = "file-channel")]
const READ_STABLE_ATTEMPTS: usize = 10;
#[cfg(feature = "file-channel")]
const READ_STABLE_INTERVAL: Duration = Duration::from_millis(50);

/// 帧信道（同一目录、两种含义）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FrameKind {
    /// 回合帧 `thisTurn.json`
    ThisTurn,
    /// 终局帧 `game{id}_finalScore.json`
    FinalScore,
}

impl FrameKind {
    /// 该信道的**示例文件名**
    ///
    /// `ThisTurn` 恒为 `thisTurn.json`；`FinalScore` 按局号命名、无固定名，
    /// 这里返回的是旧固定名（只作兼容展示）。**判别与拼路径请用
    /// [`Self::from_file_name`] / 通道给出的实际文件名**。
    pub fn file_name(self) -> &'static str {
        match self {
            Self::ThisTurn => FRAME_THIS_TURN,
            Self::FinalScore => LEGACY_FINAL_SCORE_NAME,
        }
    }

    /// 由 basename 反查信道；不在白名单则 `None`（宿主自己读帧文件时可用）
    ///
    /// 白名单：`thisTurn.json` 与 `game{digits}_finalScore.json`；旧固定名
    /// `finalScore.json` **不命中**。
    pub fn from_file_name(name: &str) -> Option<Self> {
        if name == FRAME_THIS_TURN {
            return Some(Self::ThisTurn);
        }
        if is_final_score_name(name) {
            return Some(Self::FinalScore);
        }
        None
    }
}

/// `game{id}_finalScore.json`：前缀 `game` + 非空纯数字局号 + 后缀
fn is_final_score_name(name: &str) -> bool {
    name.strip_prefix("game")
        .and_then(|rest| rest.strip_suffix(FINAL_SCORE_SUFFIX))
        .is_some_and(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()))
}

/// 一份**读取目标**：信道 + 目录内的具体文件名
///
/// 终局帧按局号命名，所以「信道 → 读哪个文件」不能靠固定名反推，必须带着文件名走；
/// 去重键也用它（按文件名去重，不按信道去重）。
#[derive(Debug, Clone, PartialEq, Eq)]
struct FrameTarget {
    /// 信道
    kind: FrameKind,
    /// 目录内的 basename
    file_name: String,
}

impl FrameTarget {
    /// 回合帧目标（固定名）
    fn this_turn() -> Self {
        Self {
            kind: FrameKind::ThisTurn,
            file_name: FRAME_THIS_TURN.to_string(),
        }
    }

    /// 按 basename 构造（调用方已用 [`FrameKind::from_file_name`] 判定过信道）
    fn new(kind: FrameKind, file_name: impl Into<String>) -> Self {
        Self {
            kind,
            file_name: file_name.into(),
        }
    }

    /// 目录内路径
    fn path(&self, dir: &Path) -> PathBuf {
        dir.join(&self.file_name)
    }
}

/// 一份稳定读到的帧原文
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawFrame {
    /// 信道（由文件名判定）
    pub kind: FrameKind,
    /// 文件原文（JSON）
    pub contents: String,
}

/// 通道运行期的非致命问题（自愈痕迹，引擎不打印）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChannelNote {
    /// 稳定读耗尽：该帧未入队，本次事件丢弃、等下一个写事件
    ReadFailed {
        /// 出问题的信道
        kind: FrameKind,
        /// 失败详情
        detail: String,
    },
    /// notify 事件错误（可能丢事件）：已重读全部白名单兜底
    WatchError {
        /// 错误详情
        detail: String,
    },
}

/// 插件输出目录：`<root>/.portable/PluginData/SendGameStatusPlugin`
///
/// 根目录由宿主注入（游戏根目录 / 运行目录），本层不做平台探测。
pub fn plugin_dir(root: impl AsRef<Path>) -> PathBuf {
    root.as_ref().join(PORTABLE_DIR).join(Path::new(PLUGIN_SUBDIR))
}

/// 处理队列元素：帧或自愈痕迹
#[cfg(feature = "file-channel")]
#[derive(Debug)]
enum ChannelItem {
    Frame(RawFrame),
    Note(ChannelNote),
}

/// 帧通道：目录监听 + 稳定读 + 去重入队，消费侧按超时取帧
#[cfg(feature = "file-channel")]
pub struct FileChannel {
    /// 保持 watcher 存活（drop 即停止监听，producer 随之退出）
    _watcher: RecommendedWatcher,
    /// 处理队列（由 producer 推入）
    queue_rx: Receiver<ChannelItem>,
    /// 尚未被宿主取走的自愈痕迹
    notes: Vec<ChannelNote>,
    /// producer 线程句柄
    _producer: JoinHandle<()>,
}

#[cfg(feature = "file-channel")]
impl FileChannel {
    /// 打开通道：要求插件输出目录**已存在**，否则按配置问题报错
    ///
    /// 目录存在但白名单文件尚未出现（育成未开始）属正常等待态：`open` 成功、只是取不到帧。
    /// 现存的白名单文件会在启动时各推一份（兜底），内容是否采纳由调用方按局号判断。
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let dir = plugin_dir(root);
        if !dir.is_dir() {
            return Err(anyhow!(
                "小黑板数据目录不存在：{}（请检查根目录与插件是否正常工作）",
                dir.display()
            ));
        }
        let (event_tx, event_rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(event_tx).context("建立文件监听失败")?;
        watcher
            .watch(&dir, RecursiveMode::NonRecursive)
            .with_context(|| format!("监听目录失败：{}", dir.display()))?;

        let (queue_tx, queue_rx) = mpsc::channel();
        let producer = thread::Builder::new()
            .name("umaai-frame-channel".to_string())
            .spawn(move || producer_loop(event_rx, queue_tx, dir))
            .context("启动通道线程失败")?;
        Ok(Self {
            _watcher: watcher,
            queue_rx,
            notes: Vec::new(),
            _producer: producer,
        })
    }

    /// 取下一份帧：`Ok(None)` = 超时（这一拍没有新帧），`Err` = 通道已关闭
    pub fn next_frame(&mut self, timeout: Duration) -> Result<Option<RawFrame>> {
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.queue_rx.recv_timeout(left) {
                Ok(ChannelItem::Frame(frame)) => return Ok(Some(frame)),
                Ok(ChannelItem::Note(note)) => self.notes.push(note),
                Err(RecvTimeoutError::Timeout) => return Ok(None),
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(anyhow!("帧通道已关闭（producer 线程已退出）"));
                }
            }
        }
    }

    /// 取走自愈痕迹（取走即清空；不取也不影响帧的到达）
    pub fn drain_notes(&mut self) -> Vec<ChannelNote> {
        std::mem::take(&mut self.notes)
    }
}

/// 稳定读：写入中可能读到空 / 半截内容或撞上文件锁，带重试 + 两次一致校验
///
/// 重试耗尽但读到过内容 → 返回最后一次内容（宽容）；一次都没读到才报错。
#[cfg(feature = "file-channel")]
fn read_stable(path: &Path) -> Result<String> {
    let mut last_ok: Option<String> = None;
    for _ in 0..READ_STABLE_ATTEMPTS {
        match fs::read_to_string(path) {
            // 空文件 = 正在被 truncate 写入
            Ok(contents) if contents.is_empty() => thread::sleep(READ_STABLE_INTERVAL),
            Ok(contents) => {
                if last_ok.as_deref() == Some(contents.as_str()) {
                    return Ok(contents);
                }
                last_ok = Some(contents);
                thread::sleep(READ_STABLE_INTERVAL);
            }
            // 文件被独占打开等瞬时错误
            Err(_) => thread::sleep(READ_STABLE_INTERVAL),
        }
    }
    last_ok.ok_or_else(|| anyhow!("多次读取 {} 失败（文件可能持续被写入）", path.display()))
}

/// producer 主体：消费 notify 事件 → 稳定读白名单文件 → 去重后入队
#[cfg(feature = "file-channel")]
fn producer_loop(event_rx: Receiver<notify::Result<Event>>, queue_tx: Sender<ChannelItem>, dir: PathBuf) {
    // 去重表按**文件名**记「上次已入队内容」：内容相同不入队，不同一律入队，一份不丢。
    // 不能按信道记：终局帧按局号命名，每局一个新文件名，按信道记会把新局当成「内容变化」之外的噪声。
    let mut last_pushed: HashMap<String, String> = HashMap::new();

    // 启动兜底：白名单文件已存在（中途重启 / 结算画面重启）时各推一份；
    // 终局帧可能积着多局，只取 mtime 最新的一份。
    for target in startup_targets(&dir) {
        read_and_push(&dir, &target, &queue_tx, &mut last_pushed);
    }

    while let Ok(event) = event_rx.recv() {
        match event {
            Ok(event) => {
                for target in matched_targets(&event) {
                    read_and_push(&dir, &target, &queue_tx, &mut last_pushed);
                }
            }
            Err(e) => {
                // 事件可能已丢：留痕 + 重读全部白名单兜底（内容变化才入队）
                let _ = queue_tx.send(ChannelItem::Note(ChannelNote::WatchError { detail: e.to_string() }));
                for target in startup_targets(&dir) {
                    read_and_push(&dir, &target, &queue_tx, &mut last_pushed);
                }
            }
        }
    }
}

/// 启动（以及事件丢失兜底）时要读的目标：回合帧固定一份，终局帧取现有最新一份
#[cfg(feature = "file-channel")]
fn startup_targets(dir: &Path) -> Vec<FrameTarget> {
    let mut targets = Vec::new();
    if dir.join(FRAME_THIS_TURN).is_file() {
        targets.push(FrameTarget::this_turn());
    }
    if let Some(target) = latest_final_score(dir) {
        targets.push(target);
    }
    targets
}

/// 目录里 mtime 最新的终局帧（同 mtime 时取名字较大的，保证确定性）
#[cfg(feature = "file-channel")]
fn latest_final_score(dir: &Path) -> Option<FrameTarget> {
    let entries = fs::read_dir(dir).ok()?;
    let mut best: Option<(SystemTime, String)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if FrameKind::from_file_name(&name) != Some(FrameKind::FinalScore) {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let better = match &best {
            Some((time, kept)) => mtime > *time || (mtime == *time && name > *kept),
            None => true,
        };
        if better {
            best = Some((mtime, name));
        }
    }
    best.map(|(_, name)| FrameTarget::new(FrameKind::FinalScore, name))
}

/// 读一份目标并去重入队；失败只留痕，等下一个事件
#[cfg(feature = "file-channel")]
fn read_and_push(
    dir: &Path,
    target: &FrameTarget,
    tx: &Sender<ChannelItem>,
    last_pushed: &mut HashMap<String, String>,
) {
    match read_stable(&target.path(dir)) {
        Ok(contents) => {
            if last_pushed.get(&target.file_name).map(String::as_str) != Some(contents.as_str()) {
                last_pushed.insert(target.file_name.clone(), contents.clone());
                let _ = tx.send(ChannelItem::Frame(RawFrame { kind: target.kind, contents }));
            }
        }
        Err(e) => {
            let _ = tx.send(ChannelItem::Note(ChannelNote::ReadFailed {
                kind: target.kind,
                detail: e.to_string(),
            }));
        }
    }
}

/// 事件命中的目标（按 basename 匹配，避开路径前缀差异）；同一次事件里的重复文件名只留一份
///
/// 只认 Create / Modify：Remove / Rename 不触发重读。
#[cfg(feature = "file-channel")]
fn matched_targets(event: &Event) -> Vec<FrameTarget> {
    if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
        return Vec::new();
    }
    let mut targets: Vec<FrameTarget> = Vec::new();
    for path in &event.paths {
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(kind) = FrameKind::from_file_name(name) else {
            continue;
        };
        let target = FrameTarget::new(kind, name);
        if !targets.contains(&target) {
            targets.push(target);
        }
    }
    targets
}

/// 帧形态测试：不依赖文件监听，特性关闭时也守
#[cfg(test)]
mod frame_tests {
    use super::*;

    /// 层1：根目录注入后的目录形态固定
    #[test]
    fn test_plugin_dir() {
        let dir = plugin_dir("game_root");
        assert!(
            dir.ends_with("SendGameStatusPlugin"),
            "目录名应取常量：{}",
            dir.display()
        );
        assert!(dir.starts_with("game_root"), "应落在注入根目录下：{}", dir.display());
        assert!(
            dir.to_string_lossy().contains(".portable"),
            "应经 .portable：{}",
            dir.display()
        );
    }

    /// 层1：文件名 → 信道；固定名 + 局号名命中，旧固定名与非白名单不命中
    #[test]
    fn test_frame_kind_lookup() {
        assert_eq!(FrameKind::from_file_name(FRAME_THIS_TURN), Some(FrameKind::ThisTurn));
        assert_eq!(
            FrameKind::from_file_name("game6308_finalScore.json"),
            Some(FrameKind::FinalScore)
        );
        assert_eq!(
            FrameKind::from_file_name("game1_finalScore.json"),
            Some(FrameKind::FinalScore)
        );
        // 旧固定名已废弃：不再识别（E1 反向用例）
        assert_eq!(FrameKind::from_file_name("finalScore.json"), None);
        // 局号必须是非空纯数字
        assert_eq!(FrameKind::from_file_name("game_finalScore.json"), None);
        assert_eq!(FrameKind::from_file_name("game6310x_finalScore.json"), None);
        assert_eq!(FrameKind::from_file_name("game6310_finalScore.json.bak"), None);
        // 归档帧与其它文件不进白名单
        assert_eq!(FrameKind::from_file_name("game6264_turn0.json"), None);
        assert_eq!(FrameKind::from_file_name("game6264_turn0_2.json"), None);
        assert_eq!(FrameKind::ThisTurn.file_name(), FRAME_THIS_TURN);
    }
}

#[cfg(all(test, feature = "file-channel"))]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind};

    /// 造一条合成 notify 事件
    fn event(kind: EventKind, path: PathBuf) -> Event {
        Event {
            kind,
            paths: vec![path],
            attrs: notify::event::EventAttributes::default(),
        }
    }

    /// 建一个空测试目录（名带 pid，避免并行用例互相踩文件）
    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("umaai_channel_{name}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建测试目录");
        dir
    }

    /// 起 producer（合成事件通道喂入，不依赖真 watcher 的事件派发）
    #[allow(clippy::type_complexity)]
    fn start_producer(dir: &Path) -> (Sender<notify::Result<Event>>, Receiver<ChannelItem>, JoinHandle<()>) {
        let (event_tx, event_rx) = mpsc::channel();
        let (queue_tx, queue_rx) = mpsc::channel();
        let dir = dir.to_path_buf();
        let handle = thread::spawn(move || producer_loop(event_rx, queue_tx, dir));
        (event_tx, queue_rx, handle)
    }

    /// 取一项（3 秒上限，超时即失败——测试绝不无限阻塞）
    fn recv_item(rx: &Receiver<ChannelItem>) -> ChannelItem {
        rx.recv_timeout(Duration::from_secs(3))
            .expect("应有入队项（超时即失败）")
    }

    /// 取下一份帧（沿途的痕迹丢弃）
    fn recv_frame(rx: &Receiver<ChannelItem>) -> RawFrame {
        loop {
            match recv_item(rx) {
                ChannelItem::Frame(frame) => return frame,
                ChannelItem::Note(_) => continue,
            }
        }
    }

    /// 断言 250ms 内没有任何入队项
    fn assert_idle(rx: &Receiver<ChannelItem>) {
        assert!(
            matches!(
                rx.recv_timeout(Duration::from_millis(250)),
                Err(RecvTimeoutError::Timeout)
            ),
            "不应有新入队项"
        );
    }

    /// 层1：事件筛选——只认白名单 basename（回合帧固定名 / 终局帧局号名），且只认 Create / Modify
    #[test]
    fn test_matched_targets() {
        let other_dir = PathBuf::from("other").join(FRAME_THIS_TURN);
        let targets = matched_targets(&event(EventKind::Modify(ModifyKind::Any), other_dir));
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].kind, FrameKind::ThisTurn);
        assert_eq!(targets[0].file_name, FRAME_THIS_TURN);

        let final_path = PathBuf::from("game6310_finalScore.json");
        let targets = matched_targets(&event(EventKind::Create(CreateKind::Any), final_path));
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].kind, FrameKind::FinalScore);
        assert_eq!(targets[0].file_name, "game6310_finalScore.json");

        // 旧固定名不再命中
        assert!(
            matched_targets(&event(
                EventKind::Modify(ModifyKind::Any),
                PathBuf::from(LEGACY_FINAL_SCORE_NAME)
            ))
            .is_empty(),
            "旧 finalScore.json 不应命中"
        );
        assert!(
            matched_targets(&event(
                EventKind::Modify(ModifyKind::Any),
                PathBuf::from("game1_turn0.json")
            ))
            .is_empty()
        );
        assert!(
            matched_targets(&event(
                EventKind::Remove(notify::event::RemoveKind::Any),
                PathBuf::from(FRAME_THIS_TURN)
            ))
            .is_empty()
        );
    }

    /// 层1：一次事件带多个路径且同名 → 只留一份目标
    #[test]
    fn test_matched_targets_dedup_by_name() {
        let path = PathBuf::from("game6310_finalScore.json");
        let multi = Event {
            kind: EventKind::Modify(ModifyKind::Any),
            paths: vec![path.clone(), path],
            attrs: notify::event::EventAttributes::default(),
        };
        assert_eq!(matched_targets(&multi).len(), 1);
    }

    /// 层1：稳定读——内容不再变化时返回；空文件与缺失文件报错（重试有界）
    #[test]
    fn test_read_stable() {
        let dir = test_dir("read");
        let path = dir.join(FRAME_THIS_TURN);

        fs::write(&path, r#"{"turn":1}"#).expect("写文件");
        assert_eq!(read_stable(&path).expect("稳定文件应可读"), r#"{"turn":1}"#);

        fs::write(&path, "").expect("写空文件");
        assert!(read_stable(&path).is_err(), "空文件（写入中）应为失败");

        let missing = dir.join("game1_finalScore.json");
        assert!(read_stable(&missing).is_err(), "缺失文件应为失败");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 层1：启动兜底——回合帧一份 + 终局帧取 mtime 最新一份
    #[test]
    fn test_startup_fallback() {
        let dir = test_dir("fallback");
        fs::write(dir.join(FRAME_THIS_TURN), r#"{"turn":77}"#).expect("写回合帧");
        fs::write(dir.join("game6308_finalScore.json"), r#"{"scenarioId":15,"id":6308}"#).expect("写旧局终局帧");
        thread::sleep(Duration::from_millis(20));
        fs::write(dir.join("game6309_finalScore.json"), r#"{"scenarioId":15,"id":6309}"#).expect("写新局终局帧");
        // 旧固定名不该被读到
        fs::write(dir.join(LEGACY_FINAL_SCORE_NAME), r#"{"scenarioId":15,"id":0}"#).expect("写旧固定名");

        let (event_tx, rx, handle) = start_producer(&dir);
        let first = recv_frame(&rx);
        assert_eq!(first.kind, FrameKind::ThisTurn);
        assert_eq!(first.contents, r#"{"turn":77}"#);
        let second = recv_frame(&rx);
        assert_eq!(second.kind, FrameKind::FinalScore);
        assert_eq!(second.contents, r#"{"scenarioId":15,"id":6309}"#, "取 mtime 最新的一份");
        // 旧局终局帧与旧固定名都不该再推
        assert_idle(&rx);

        drop(event_tx);
        handle.join().expect("producer 应正常退出");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 层1：去重——同内容不入队，内容变化一律入队
    #[test]
    fn test_dedup_keeps_distinct() {
        let dir = test_dir("dedup");
        let path = dir.join(FRAME_THIS_TURN);
        fs::write(&path, r#"{"turn":1}"#).expect("写文件");

        let (event_tx, rx, handle) = start_producer(&dir);
        assert_eq!(recv_frame(&rx).contents, r#"{"turn":1}"#);

        // 内容未变的冗余事件 → 不入队
        event_tx
            .send(Ok(event(EventKind::Modify(ModifyKind::Any), path.clone())))
            .unwrap();
        assert_idle(&rx);

        // 内容变化 → 入队（先写后发事件，保证读到新内容）
        fs::write(&path, r#"{"turn":2}"#).expect("写文件");
        event_tx
            .send(Ok(event(EventKind::Modify(ModifyKind::Any), path.clone())))
            .unwrap();
        assert_eq!(recv_frame(&rx).contents, r#"{"turn":2}"#);

        fs::write(&path, r#"{"turn":3}"#).expect("写文件");
        event_tx
            .send(Ok(event(EventKind::Modify(ModifyKind::Any), path.clone())))
            .unwrap();
        assert_eq!(recv_frame(&rx).contents, r#"{"turn":3}"#);

        drop(event_tx);
        handle.join().expect("producer 应正常退出");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 层1：两条信道各自去重；终局帧按**文件名**去重（新局新名 → 照常入队）
    #[test]
    fn test_final_score_channel_independent() {
        let dir = test_dir("final");
        let turn = dir.join(FRAME_THIS_TURN);
        fs::write(&turn, r#"{"turn":1}"#).expect("写回合帧");

        let (event_tx, rx, handle) = start_producer(&dir);
        assert_eq!(recv_frame(&rx).kind, FrameKind::ThisTurn);

        let final_path = dir.join("game6310_finalScore.json");
        fs::write(&final_path, r#"{"single_mode_chara_id":6310}"#).expect("写终局帧");
        event_tx
            .send(Ok(event(EventKind::Create(CreateKind::Any), final_path.clone())))
            .unwrap();
        assert_eq!(recv_frame(&rx).kind, FrameKind::FinalScore);

        // 同文件同内容再触发 → 去重
        event_tx
            .send(Ok(event(EventKind::Modify(ModifyKind::Any), final_path.clone())))
            .unwrap();
        assert_idle(&rx);

        // 同文件覆盖写 → 内容变化仍入队
        fs::write(&final_path, r#"{"single_mode_chara_id":6311}"#).expect("写终局帧");
        event_tx
            .send(Ok(event(EventKind::Modify(ModifyKind::Any), final_path.clone())))
            .unwrap();
        assert!(recv_frame(&rx).contents.contains("6311"));

        // 下一局的终局帧是**另一个文件名**：即便内容与上一份相同也应入队（按文件名去重）
        let next_path = dir.join("game6311_finalScore.json");
        fs::write(&next_path, r#"{"single_mode_chara_id":6311}"#).expect("写下一局终局帧");
        event_tx
            .send(Ok(event(EventKind::Create(CreateKind::Any), next_path)))
            .unwrap();
        assert_eq!(recv_frame(&rx).kind, FrameKind::FinalScore);

        drop(event_tx);
        handle.join().expect("producer 应正常退出");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 层2：notify 报错 → 留痕 + 重读全部白名单兜底
    #[test]
    fn test_watch_error_rereads() {
        let dir = test_dir("watch_err");
        let path = dir.join(FRAME_THIS_TURN);
        fs::write(&path, r#"{"turn":1}"#).expect("写文件");

        let (event_tx, rx, handle) = start_producer(&dir);
        assert_eq!(recv_frame(&rx).contents, r#"{"turn":1}"#);

        // 报错前写入新内容：重读兜底应把它捞回来
        fs::write(&path, r#"{"turn":9}"#).expect("写文件");
        event_tx.send(Err(notify::Error::generic("模拟缓冲溢出"))).unwrap();
        match recv_item(&rx) {
            ChannelItem::Note(ChannelNote::WatchError { .. }) => {}
            other => panic!("应留下 WatchError 痕迹，实为 {other:?}"),
        }
        assert_eq!(recv_frame(&rx).contents, r#"{"turn":9}"#);

        drop(event_tx);
        handle.join().expect("producer 应正常退出");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 层2：白名单文件读不到 → 留痕（该帧跳过，等下一个事件）
    #[test]
    fn test_read_failed_note() {
        let dir = test_dir("read_fail");
        let (event_tx, rx, handle) = start_producer(&dir);

        // 文件不存在时触发事件 → 稳定读耗尽 → ReadFailed 痕迹
        event_tx
            .send(Ok(event(EventKind::Modify(ModifyKind::Any), dir.join(FRAME_THIS_TURN))))
            .unwrap();
        match recv_item(&rx) {
            ChannelItem::Note(ChannelNote::ReadFailed { kind, .. }) => assert_eq!(kind, FrameKind::ThisTurn),
            other => panic!("应留下 ReadFailed 痕迹，实为 {other:?}"),
        }

        drop(event_tx);
        handle.join().expect("producer 应正常退出");
        let _ = fs::remove_dir_all(&dir);
    }
}
