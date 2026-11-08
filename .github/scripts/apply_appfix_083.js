#!/usr/bin/env node
// [APP-FIX-083] 三个软件同时开：18766 被 DSH 占用时 App 不能崩，也不能没有帧。
//   现状：start() 里 ServerSocket(18766) 一抛异常就 return false → pullLoop 也没起 → 彻底收不到帧。
//   改法：① 按顺序试 18766 → 18764 → 18772 → 18773，绑定成功就用哪个；
//        ② 绑不上也照常启动 pullLoop（App 主动从 SO 的 18765 拉 /summary），帧不会断。
//   这样 DSH 占 18766、App 用 18764（或纯拉），游戏照常推（推失败无害）。
const fs = require('fs');
const P = process.argv[2];
if (!P) throw new Error('usage: apply_appfix_083.js <NativeEngine.kt>');
let s = fs.readFileSync(P, 'utf8');
if (s.includes('[APP-FIX-083]')) { console.log('already applied'); process.exit(0); }
const once = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error('anchor count=' + n + ' for: ' + JSON.stringify(a.slice(0, 60)));
  s = s.split(a).join(b);
};

once(
  '    private const val PULL_STALE_MS = 20000L',
  '    private const val PULL_STALE_MS = 20000L\n' +
  '    // [APP-FIX-083] 实际绑定到的接收端口（0 = 没绑上，只靠 pull 收帧）\n' +
  '    @Volatile var boundPort: Int = 0'
);

const oldBlock = [
  '            val server = ServerSocket(port, 32, InetAddress.getByName(host))',
  '            sessionDir = File(dir).apply { mkdirs() }',
  '            restoreFromArchive()',
  '            running.set(true)',
  '            Thread({ loop(server) }, "matsuri-18766").apply { isDaemon = true }.start()',
  '            Thread({ probeLoop() }, "matsuri-so-probe").apply { isDaemon = true }.start()',
  '            Thread({ pullLoop() }, "matsuri-so-pull").apply { isDaemon = true }.start()',
  '            true',
].join('\n');
const newBlock = [
  '            // [APP-FIX-083] 18766 可能被 DSH 之类占用：换端口绑；绑不上也继续（走 pullLoop）',
  '            var server: ServerSocket? = null',
  '            for (p in intArrayOf(port, 18764, 18772, 18773)) {',
  '                try {',
  '                    server = ServerSocket(p, 32, InetAddress.getByName(host))',
  '                    boundPort = p',
  '                    break',
  '                } catch (ignored: Exception) {',
  '                }',
  '            }',
  '            sessionDir = File(dir).apply { mkdirs() }',
  '            restoreFromArchive()',
  '            running.set(true)',
  '            val srv = server',
  '            if (srv != null) {',
  '                Thread({ loop(srv) }, "matsuri-recv").apply { isDaemon = true }.start()',
  '            }',
  '            Thread({ probeLoop() }, "matsuri-so-probe").apply { isDaemon = true }.start()',
  '            Thread({ pullLoop() }, "matsuri-so-pull").apply { isDaemon = true }.start()',
  '            true',
].join('\n');
once(oldBlock, newBlock);

fs.writeFileSync(P, s);
console.log('app-fix-083 applied');