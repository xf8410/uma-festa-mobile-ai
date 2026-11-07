#!/usr/bin/env node
// [LOG-FIX-3292] 修插件的逐步日志路径（原包名写错 jp.pokemon.pokeuma）+ 内存环状日志，
// 让闪退前最后几步能捞出来。幂等。
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
const MARK = '// [LOG-FIX-3292]';
if (s.includes(MARK)) { console.log('already applied'); process.exit(0); }

const rep = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error(`anchor count=${n}: ${JSON.stringify(a.slice(0, 60))}`);
  s = s.split(a).join(b);
};

// 1) 环状日志缓冲
const ANCHOR_STEP = 'fn log_predict_step(msg: &str) {';
rep(ANCHOR_STEP, `${MARK}
const RING_SLOTS: usize = 200;
const RING_LINE: usize = 96;
static mut RING_BUF: [[u8; RING_LINE]; RING_SLOTS] = [[0; RING_LINE]; RING_SLOTS];
static RING_IDX: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

unsafe fn ring_push(msg: &str) {
    let idx = RING_IDX.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let slot = idx % RING_SLOTS;
    let base = RING_BUF.as_mut_ptr() as *mut u8;
    let dst = base.add(slot * RING_LINE);
    for i in 0..RING_LINE {
        *dst.add(i) = 0;
    }
    let n = msg.len().min(RING_LINE - 1);
    std::ptr::copy_nonoverlapping(msg.as_ptr(), dst, n);
}

unsafe fn ringlog_json() -> String {
    let n = RING_IDX.load(std::sync::atomic::Ordering::Relaxed);
    let start = if n > RING_SLOTS { n - RING_SLOTS } else { 0 };
    let mut items: Vec<String> = Vec::new();
    let base = RING_BUF.as_ptr() as *const u8;
    for i in start..n {
        let slot = i % RING_SLOTS;
        let src = base.add(slot * RING_LINE);
        let mut end = RING_LINE;
        for k in 0..RING_LINE {
            if *src.add(k) == 0 {
                end = k;
                break;
            }
        }
        let bytes = std::slice::from_raw_parts(src, end);
        let text = String::from_utf8_lossy(bytes)
            .replace('\\\\', "")
            .replace('"', "'");
        items.push(format!("{}:{}", i + 1, text));
    }
    format!(
        r#"{{"ok":true,"count":{},"total":{},"steps":["{}"]}}"#,
        items.len(),
        n,
        items.join("\\",\\"")
    )
}

${ANCHOR_STEP}`);

// 2) 每次打点也进环
rep(`    let line = format!("[{}] {}\\n", step, msg);`,
    `    let line = format!("[{}] {}\\n", step, msg);
    unsafe {
        ring_push(msg);
    }`);

// 3) 包名修对（原写的是 jp.pokemon.pokeuma，另一个游戏），并把预测日志挪到 media 目录便于取
const MEDIA = "/sdcard/Android/media/jp.co.cygames.umamusume/hachimi";
s = s.split("jp.pokemon.pokeuma").join("jp.co.cygames.umamusume");
s = s.split("/data/data/jp.co.cygames.umamusume/files/uma_predict.log").join(MEDIA + "/uma_predict.log");

// 4) 端点 /debug/ringlog
rep('    "/debug/selftest",', '    "/debug/selftest",\n    "/debug/ringlog",');
rep('    } else if path == "/debug/selftest" {',
    '    } else if path == "/debug/ringlog" {\n        unsafe { ringlog_json() }\n    } else if path == "/debug/selftest" {');

fs.writeFileSync(P, s);
console.log('log-fix applied, bytes=' + Buffer.byteLength(s));