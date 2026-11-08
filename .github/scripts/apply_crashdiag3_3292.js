#!/usr/bin/env node
// [CRASH-DIAG3-3292] 用 getpid() 判定主线程（之前的 MAIN_TID 可能是加载线程，会误报 MT），
// 崩溃行加上线程 tid（十六进制），并在每次读盘面开始时记录读线程 tid。
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
const MARK = '// [CRASH-DIAG3-3292]';
if (s.includes(MARK)) { console.log('already applied'); process.exit(0); }

const rep = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error(`anchor count=${n}: ${JSON.stringify(a.slice(0, 60))}`);
  s = s.split(a).join(b);
};

// 1) 主线程判定改成 tid == pid，并把 tid 写进崩溃行
rep('    let mt = MAIN_TID.load(std::sync::atomic::Ordering::Relaxed);\n    if mt != 0 && cur_tid == mt {',
`    ${MARK} 主线程 tid == 进程 pid
    let is_main = cur_tid == unsafe { libc::getpid() };
    // 把 tid 写成十六进制，方便和日志里的线程对照
    let mut __t = cur_tid as u32;
    let mut __started = false;
    msg[len] = b' ';
    len += 1;
    msg[len] = b't';
    len += 1;
    msg[len] = b'=';
    len += 1;
    for i in (0..8).rev() {
        let d = ((__t >> (i * 4)) & 0xF) as u8;
        if d != 0 || __started || i == 0 {
            msg[len] = if d < 10 { b'0' + d } else { b'a' + d - 10 };
            len += 1;
            __started = true;
        }
    }
    if is_main {`);

// 2) 每次读盘面开始记录读线程 tid
rep('fn read_summary() -> String {',
`fn read_summary() -> String {
    ${MARK} read_tid
    {
        let tid = unsafe { libc::syscall(libc::SYS_gettid) } as u32;
        log_predict_step(&format!("S:read_tid={:x}", tid));
    }`);

fs.writeFileSync(P, s);
console.log('crash-diag3 applied, bytes=' + Buffer.byteLength(s));