#!/usr/bin/env node
// [PUSHFALLBACK-3292] SO 推送目标默认 18766，但那被 DSH 占用 → App 永远收不到推送（只能靠拉取）。
// 改成：先按配置端口推，连不上再依次试 18764 / 18772 / 18773（App 的兜底端口），成功即返回。
const fs = require('fs');
const P = process.argv[2] || 'so/hachimi_ura_plugin/src/lib.rs';
let s = fs.readFileSync(P, 'utf8');
if (s.includes('[PUSHFALLBACK-3292]')) { console.log('already applied'); process.exit(0); }
const startMark = 'fn push_to_app(json: &str) {';
const endMark = '\n\nfn push_loop() {';
const a = s.indexOf(startMark);
const b = s.indexOf(endMark, a);
if (a < 0 || b < 0) throw new Error('push_to_app block not found');
const block = [
  'fn push_to_app(json: &str) {',
  '    use std::io::{Read, Write};',
  '    // [PUSHFALLBACK-3292] 18766 常被别的进程占用（例如 DSH 自己的服务）→',
  '    // 先试配置端口，再依次试 App 的兜底端口 18764/18772/18773。',
  '    let cfg = unsafe { get_config() };',
  '    if !cfg.push_enabled {',
  '        return;',
  '    }',
  '    let host = cfg.push_host.clone();',
  '    let mut ports: Vec<u16> = vec![cfg.push_port];',
  '    for p in [18764u16, 18772, 18773] {',
  '        if !ports.contains(&p) {',
  '            ports.push(p);',
  '        }',
  '    }',
  '    let body = json.as_bytes();',
  '    for port in ports {',
  '        let addr_str = format!("{}:{}", host, port);',
  '        let addr: std::net::SocketAddr = match addr_str.parse() {',
  '            Ok(a) => a,',
  '            Err(_) => continue,',
  '        };',
  '        let mut stream = match std::net::TcpStream::connect_timeout(',
  '            &addr,',
  '            std::time::Duration::from_millis(800),',
  '        ) {',
  '            Ok(s) => s,',
  '            Err(_) => continue, // 这个端口没人听，试下一个',
  '        };',
  '        let req = format!(',
  '            "POST /data HTTP/1.1\\r\\nHost: {}\\r\\nContent-Type: application/json\\r\\nContent-Length: {}\\r\\nConnection: close\\r\\n\\r\\n",',
  '            addr_str, body.len()',
  '        );',
  '        let mut ok = stream.write_all(req.as_bytes()).is_ok();',
  '        if ok {',
  '            ok = stream.write_all(body).is_ok();',
  '        }',
  '        let _ = stream.flush();',
  '        let mut buf = [0u8; 256];',
  '        let _ = stream.read(&mut buf);',
  '        if ok {',
  '            return;',
  '        }',
  '    }',
  '}',
].join('\n');
s = s.slice(0, a) + block + s.slice(b);
fs.writeFileSync(P, s);
console.log('pushfallback patch applied');