# uma-festa-mobile-ai

赛马娘祭典杯（剧本 15 / グランドフェスタ）**手机版**育成辅助项目源码库。

> 本仓库存在的首要目的：让参与协作的各方（包括 AI 助手）能直接读到当前真机在跑的源码，
> 避免「没有源码只能猜」。排查问题请以本仓库代码为准，不要凭推测下结论。

## 仓库结构

| 目录 | 内容 | 当前版本 |
|---|---|---|
| `so/` | SO 内存直读插件（Rust，hachimi 插件，**纯采集**：不算分、不推荐、不投影）| **v3.29.3** |
| `app/` | Android 浮窗 App（Kotlin + WebView；**算分/彩圈/决策全部在 App 侧**）| v0.9.31-dsh40 |
| `ai-engine/umaai-matsuri/` | 祭典杯模拟器核心（Rust，上游 matsuri-core 路线）| 移植中 |
| `ai-engine/umaai_next/` | AI 决策引擎（umaai_next，运气分/训练建议口径来源）| 移植中 |

## 数据链架构

```
游戏内存 ──SO插件(:18765 /summary + POST推送)──> App接收端 NativeEngine.kt(:18766)
        ──> WebView浮窗 轮询 /api/snapshot ──> 渲染紧凑面板
```

## 关键文件（排查入口）

- SO 主源码（单文件，约 24000 行）：`so/hachimi_ura_plugin/src/lib.rs`
- SO 端点清单：`so/hlpatch_endpoints.txt`
- il2cpp 类/方法 dump（逆向布局依据）：`so/data/il2cpp_dump/`
- App 接收端：`app/app/src/main/java/com/ranko/matsuricapture/NativeEngine.kt`
- 浮窗面板：`app/app/src/main/assets/float.html`

## 架构分工（2026-11-09 起对齐 PC 版：插件只采数据，AI/算分/决策全在 App 侧）

**SO = 纯采集**（对应 PC 版黑板/send 插件）。/summary 只出口游戏内存原始值 + mdb 查表富化：
- 五维/体力/干劲/技能点/适性、trainings（收益/失败率/人头原始字段）、support_cards、
  skills（mdb grade_value 求和 = 引擎 skillScore 输入）、skill_tips、festa、turn
- `evaluation` = 游戏自己的 `GetEvaluation()`（原生数据，非我方计算）
- **已移除**：启发式 AI（best_action/train_values）、SCORE 五维查定注入、
  LUCK 运气投影、SHINING 彩圈规则（3.29.2 及以前在 SO 里算，3.29.3 起全部剥离）

**App = 算分 + 决策**（对应 PC 版 AI 侧）：
- `ScoreTable.kt` 本地评价分 = **上游官方口径**（umaai-core score.rs）：
  五维逐项 `status_point(min(属性, 剧本上限))` 求和（0–2803 与旧表逐位一致、2800+ 外推不封顶）
  ＋ PT×2.0 ＋ 技能分（SO mdb 评价值和），附 rank 档次表（G…LS24）
- 运气分 PC 口径（umaai luck.rs）：显示分 E 由引擎投影（raw+(77−t)×100），
  本轮 = E_t−E_{t−1}，本局 = E_t−E_首−首回合×100
- 彩圈/固有本地推导：`train_type == 当前训练 && bond >= 80` / `bond >= bond_threshold`
  （引擎 umaai-next traits.rs:362 口径，SO 只出口原始 train_type/bond/threshold）
- 引擎决策：EngineBridge 双档（matsuri/search）子进程 → mergeDecision 回写
  （expected=搜索档期望、luck_turn/luck_game、train_advice（仅 train 决策）、ai_candidates；
  hand 档无 detail 时回退 candidate_scores 打分表原始分展示）
- **引擎参数用户可调**（浮窗齿轮 ⚙）：搜索线程数（RAYON_NUM_THREADS，默认 4）与
  搜索局数（MATSURI_SEARCH_N，默认 8192，0 = 纯手写档），保存即重启引擎；
  引擎崩溃自动重拉（≤3 次）；arm64 必带、armeabi-v7a 尽力构建（32 位兼容）
- 浮窗交互：右下角 ◢ 把手自由缩放（无级）、折叠迷你条**点按恢复**、透明度 30–100% 可调

```
游戏内存 ─SO(:18765 /summary+POST推送，18766被占自动改推18764/18772/18773)
  → App接收端 NativeEngine(:18766…) ─WebView浮窗轮询 /api/snapshot
  │    normalize(): 本地评价分(ScoreTable 官方口径) + 本地彩圈推导(APP-SHINE-3293)
  └→ EngineBridge（APK 内置 matsuri 引擎子进程，online 双档 matsuri/search）
       每帧 /summary → FrameAdapter → thisTurn.json → 引擎
       引擎 decision ─[AI-WIRE] onDecision 回调→ mergeDecision 回写最新帧
       （expected=搜索档期望终局分、luck_turn/luck_game=umaai luck.rs 口径、
         train_advice[5列]、ai_candidates 候选榜、ai_top 首选）
```

- 引擎 = 上游 umaai-matsuri **main**（PR#3 已于 2026-11-09 合入，1914a18）CI 现合现编
- 真机 SIGSEGV 已根修（arrayfix：`read_il2cpp_int_list` 把内联 ObscuredInt[] 误当指针数组解引用）
- festa 已接线：sid=15 走 `WorkSingleModeCharaData.<ScenarioFesta>@1232` 字段直读，acts/教诲/检查点进 /summary
- 源码 = 仓库内权威版本（SO 3.29.3 / App 0.9.31-dsh40）；CI **不再重放任何 apply_\* 补丁**
  （旧 3.29.2 工作流已全部退役，防已删除的启发式代码被补丁注回）；CI 发布步骤禁止 force-push

## 编译

### SO（Android aarch64）

```bash
# Rust 必须 1.97.1（rust-toolchain.toml 已钉版；1.99 的 invalid_runtime_symbol_definitions
# lint 会拒 sys_open 签名），NDK 26.1.10909125
export CC_aarch64_linux_android=<NDK>/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang
export AR_aarch64_linux_android=<NDK>/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-ar
cd so/hachimi_ura_plugin && cargo build --release --target aarch64-linux-android
```

### App

```bash
cd app && gradle assembleDebug   # 需自备 Android SDK 35 + JDK 17，写 local.properties 指向 SDK
```

## 版本基线说明

- **真机当前运行 = `so/`（v3.29.3 纯采集）**。交接资料里另有 `手机AI_SO重编译源码` 两个 workbench
  （3.28.16-merged-scenario15 / 3.28.17-readall-p1p2）是**未上机实验版**，不在本仓库；
  其中 `read_festa_dataset` 等 festa 代码是死代码，仅供后续 festa 接线参考。
- GitHub 上另有旧仓 `uma-festa-so-build`，只有 v3.15 旧内核，**不要**拿它当当前基线。
