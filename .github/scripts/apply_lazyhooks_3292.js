#!/usr/bin/env node
// [LAZYHOOKS-3292] 两个问题：
//  1) on_game_initialized 不触发（插件后加载）→ training/event/skill 这些 hook 一个都没装上；
//     推送线程的兜底安装只在前 60 秒试探，标题界面时读不到 summary 就放弃了。
//     → 新增 install_all_hooks_lazy()，在 /summary、/debug/skilltips_probe 这类 HTTP 请求里补装（幂等）。
//  2) 探针端点加上 SIGSEGV 保护（READ_MUTEX + sigsetjmp），像 /debug/paramsincdec 那样：
//     读技能页模型要 invoke 若干 getter，万一炸了只丢这一个请求，不带走游戏。
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
const MARK = '// [LAZYHOOKS-3292]';
if (s.includes(MARK)) { console.log('already applied'); process.exit(0); }

const once = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error(`anchor count=${n} for: ${JSON.stringify(a.slice(0, 70))}`);
  s = s.split(a).join(b);
};

// ---------- 1) 懒安装函数 ----------
const FN = `// [LAZYHOOKS-3292] 懒安装：on_game_initialized 不触发时，由 HTTP 线程补装全部 hook
static LAZY_HOOKS_DONE: AtomicBool = AtomicBool::new(false);
static LAZY_HOOKS_ATTEMPTS: AtomicU64 = AtomicU64::new(0);

unsafe fn install_all_hooks_lazy() {
    if LAZY_HOOKS_DONE.load(Ordering::Relaxed) || API.is_null() {
        return;
    }
    LAZY_HOOKS_ATTEMPTS.fetch_add(1, Ordering::Relaxed);
    install_training_hook();
    install_exec_training_hook();
    install_failure_rate_hook();
    install_event_choice_hook();
    install_skill_tips_hook();
    install_skill_model_hook();
    if SKILL_TIPS_HOOK_INSTALLED.load(Ordering::Relaxed)
        && SKILL_MODEL_HOOK_INSTALLED.load(Ordering::Relaxed)
    {
        LAZY_HOOKS_DONE.store(true, Ordering::Relaxed);
    }
    ura_log(
        2,
        &format!(
            "lazy hooks: attempt={} tips={} model={} done={}",
            LAZY_HOOKS_ATTEMPTS.load(Ordering::Relaxed),
            SKILL_TIPS_HOOK_INSTALLED.load(Ordering::Relaxed),
            SKILL_MODEL_HOOK_INSTALLED.load(Ordering::Relaxed),
            LAZY_HOOKS_DONE.load(Ordering::Relaxed)
        ),
    );
}

`;
once('unsafe fn install_training_hook() {', FN + 'unsafe fn install_training_hook() {');

// ---------- 2) 探针端点加 SIGSEGV 保护 + 懒安装 ----------
const oldBlock = `    } else if path == "/debug/skilltips_probe" {
        // [SKILLHOOK-3292] 技能提示诊断：getter / 字段 / hook 缓存
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
            debug_skilltips_probe()
        }))
        .unwrap_or_else(|_| r#"{"error":"skilltips_probe_panic"}"#.to_string())
    } else if path == "/debug/hookdiag" {`;
const newBlock = `    } else if path == "/debug/skilltips_probe" {
        // [LAZYHOOKS-3292] 先补装 hook，再在 SIGSEGV 保护下读数据
        let _lock = READ_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
        let jmp_result = unsafe { sys_sigsetjmp(SIGSEGV_JMP_BUF.as_mut_ptr(), 1) };
        if jmp_result != 0 {
            r#"{"error":"sigsegv_recovered","hint":"/debug/skilltips_probe hit native crash"}"#.to_string()
        } else {
            unsafe {
                SIGSEGV_OWNER_TID.store(
                    libc::syscall(libc::SYS_gettid) as i32,
                    std::sync::atomic::Ordering::Relaxed,
                );
            }
            SIGSEGV_RECOVERY.store(true, std::sync::atomic::Ordering::Relaxed);
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
                install_all_hooks_lazy();
                debug_skilltips_probe()
            }))
            .unwrap_or_else(|_| r#"{"error":"skilltips_probe_panic"}"#.to_string());
            SIGSEGV_RECOVERY.store(false, std::sync::atomic::Ordering::Relaxed);
            result
        }
    } else if path == "/debug/hookdiag" {`;
if (!s.includes(oldBlock)) throw new Error('probe dispatch block not found');
s = s.split(oldBlock).join(newBlock);

// ---------- 3) /summary 也补装（app 从推送线程读，手动查也走这里） ----------
once(
  `    } else if path == "/summary" {
        read_summary()`,
  `    } else if path == "/summary" {
        unsafe { install_all_hooks_lazy() };
        read_summary()`
);

fs.writeFileSync(P, s);
console.log('lazyhooks applied');