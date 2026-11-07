#!/usr/bin/env node
// [CRASH-DIAG-3292] 崩溃诊断：区分「同一线程」与「跨线程」SIGSEGV（跨线程 longjmp 会把游戏搞死），
// 并加 S:json_done 打点确认是否崩在大 format! 里。幂等。
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
const MARK = '// [CRASH-DIAG-3292]';
if (s.includes(MARK)) { console.log('already applied'); process.exit(0); }

const rep = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error(`anchor count=${n}: ${JSON.stringify(a.slice(0, 60))}`);
  s = s.split(a).join(b);
};

// 1) 记录「谁 arm 了恢复，谁在崩」
rep('static SIGSEGV_RECOVERY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);',
`static SIGSEGV_RECOVERY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
${MARK}
static SIGSEGV_OWNER_TID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);`);

// 2) 崩溃时判断是否跨线程，前缀区分
rep('    let p = b"CRASH at step ";',
`    ${MARK} tid
    let cur_tid = unsafe { libc::syscall(libc::SYS_gettid) } as i32;
    let owner_tid = SIGSEGV_OWNER_TID.load(std::sync::atomic::Ordering::Relaxed);
    let cross = SIGSEGV_RECOVERY.load(std::sync::atomic::Ordering::Relaxed) && cur_tid != owner_tid;
    let p: &[u8] = if cross { &b"CRASH-OTHER at step "[..] } else { &b"CRASH at step "[..] };`);

// 3) 跨线程绝不 longjmp（会跳到别的线程栈，直接把游戏搞崩）
rep('    if SIGSEGV_RECOVERY.load(std::sync::atomic::Ordering::Relaxed) {',
    '    if !cross && SIGSEGV_RECOVERY.load(std::sync::atomic::Ordering::Relaxed) {');

// 4) arm 时记下当前 tid
{
  const armOld = '    SIGSEGV_RECOVERY.store(true, std::sync::atomic::Ordering::Relaxed);';
  const armNew = `    unsafe {
        SIGSEGV_OWNER_TID.store(libc::syscall(libc::SYS_gettid) as i32, std::sync::atomic::Ordering::Relaxed);
    }
    SIGSEGV_RECOVERY.store(true, std::sync::atomic::Ordering::Relaxed);`;
  if (!s.includes(armOld)) throw new Error('arming site missing');
  s = s.split(armOld).join(armNew);
}

// 5) S:json_done 打点
rep('    log_predict_step("S:json");\n    format!(',
    '    log_predict_step("S:json");\n    let __json_out = format!(');
rep('        last_action_json\n    )\n}',
    '        last_action_json\n    );\n    log_predict_step("S:json_done");\n    __json_out\n}');

fs.writeFileSync(P, s);
console.log('crash-diag applied, bytes=' + Buffer.byteLength(s));