#!/usr/bin/env node
// [CRASH-DIAG2-3292] 崩溃日志补上线索：是否在恢复窗口内(ARMED/NOT-ARMED)、是否游戏主线程(MT)。
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
const MARK = '// [CRASH-DIAG2-3292]';
if (s.includes(MARK)) { console.log('already applied'); process.exit(0); }

const rep = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error(`anchor count=${n}: ${JSON.stringify(a.slice(0, 60))}`);
  s = s.split(a).join(b);
};

// 1) 主线程 tid 静态
rep('static SIGSEGV_OWNER_TID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);',
`static SIGSEGV_OWNER_TID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
${MARK}
static MAIN_TID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);`);

// 2) 安装处理器时记主线程 tid
rep('fn init_crash_handler() {\n    unsafe {',
`fn init_crash_handler() {
    // ${MARK}
    unsafe {
        MAIN_TID.store(libc::syscall(libc::SYS_gettid) as i32, std::sync::atomic::Ordering::Relaxed);
    }
    unsafe {`);

// 3) 跨线程前缀缩短，避免 64 字节缓冲溢出
rep('let p: &[u8] = if cross { &b"CRASH-OTHER at step "[..] } else { &b"CRASH at step "[..] };',
    'let p: &[u8] = if cross { &b"X-CRASH at step "[..] } else { &b"CRASH at step "[..] };');

// 4) 结尾标记区分 ARMED / NOT-ARMED，并在主线程崩溃时加 MT
rep(`    let r = b" RECOVERED";
    msg[len..len + r.len()].copy_from_slice(r);
    len += r.len();
    msg[len] = b'\\n';
    len += 1;`,
`    let armed = SIGSEGV_RECOVERY.load(std::sync::atomic::Ordering::Relaxed);
    let r: &[u8] = if armed { &b" ARMED"[..] } else { &b" NOT-ARMED"[..] };
    msg[len..len + r.len()].copy_from_slice(r);
    len += r.len();
    let mt = MAIN_TID.load(std::sync::atomic::Ordering::Relaxed);
    if mt != 0 && cur_tid == mt {
        let m = b" MT";
        msg[len..len + m.len()].copy_from_slice(m);
        len += m.len();
    }
    msg[len] = b'\\n';
    len += 1;`);

fs.writeFileSync(P, s);
console.log('crash-diag2 applied, bytes=' + Buffer.byteLength(s));