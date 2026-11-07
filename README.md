# uma-festa-mobile-ai

赛马娘祭典杯（剧本 15 / グランドフェスタ）**手机版**育成辅助项目源码库。

> 本仓库存在的首要目的：让参与协作的各方（包括 AI 助手）能直接读到当前真机在跑的源码，
> 避免「没有源码只能猜」。排查问题请以本仓库代码为准，不要凭推测下结论。

## 仓库结构

| 目录 | 内容 | 当前版本 |
|---|---|---|
| `so/` | SO 内存直读插件（Rust，hachimi 插件，真机正在运行）| **v3.29.2** |
| `app/` | Android 浮窗 App（Kotlin + WebView 紧凑面板）| v0.7.4-festa-compact |
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

## 当前未决故障（2026-11-07 真机实测）

### 1. SIGSEGV 确定性崩溃（最高优先级）

真机实测证据：

- `/summary` 在 phase1 崩溃，两次崩溃 `last_step` 都是 **`S:after_read_speed`**
  （`/debug/crashlog` → `{"crash":true,"signal":11,"step":148}`，step 递增 148→172）
- `/debug/cmdinfo` 实测：`CommandInfoArray` 元素**就是** legacy `SingleModeCommandInfoData` 布局
  （`CommandType@16 / CommandId@36 / IsEnable@56 / TrainingPartnerArray@80 / TipsEventPartnerArray@88 /
  ParamsIncDecInfoArray@96 / FailureRate@104`），所以 v3.29.2 的「Festa 布局识别」分支不会触发，
  崩溃点在别处：**`S:after_read_speed` 之后、下一个埋点之前的那段 getter 链**
- hooklog 显示 phase2~p6 有完整跑通的轮次，是健康的
- 崩溃后进入 60 秒全局冷却，`push_loop` 每 5 秒拿到 error JSON 直接 continue → 永远不推送给 App

**下一步（已定方案）**：在 phase1 每个 getter（stamina / power / guts / wiz / hp / maxhp /
motivation / skillpoint / fan）前后各加一个 `last_step` 埋点，出 v3.29.3，一次真机验证收敛到单个 getter。

### 2. festa 数据链断（独立故障，不引发崩溃）

- `/scenario` → `{"scenario_id":15,"error":"scenario_obj_null","hint":"getter_name_not_found"}`
- 但 `/debug/dumpclass` 实测：`WorkSingleModeCharaData` 有 `<ScenarioFesta>@1232`，
  方法表有 `get_ScenarioFesta`——类存在、属性存在，**是 sid=15 的取对象路径没覆盖**
- 后果：演目槽 / 教诲角标 / festa 块全空

### 3. 已知瑕疵

- hooklog 首条 `URA plugin v3.24.9 loaded` 与 `/health` 的 3.29.2 不符：构建里日志字符串没同步
- `/debug/all` 自己也会崩（`sigsegv_recovered_in_debug_all`）

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

- **真机当前运行 = `so/`（v3.29.2）**。交接资料里另有 `手机AI_SO重编译源码` 两个 workbench
  （3.28.16-merged-scenario15 / 3.28.17-readall-p1p2）是**未上机实验版**，不在本仓库；
  其中 `read_festa_dataset` 等 festa 代码是死代码，仅供后续 festa 接线参考。
- GitHub 上另有旧仓 `uma-festa-so-build`，只有 v3.15 旧内核，**不要**拿它当当前基线。
