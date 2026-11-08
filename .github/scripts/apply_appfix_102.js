#!/usr/bin/env node
// [APP-FIX-102] 加 /api/mdb 代理：把 SO 的 master 表探查端点透传出来（技能规划用）
//   GET /api/mdb?t=skill_data&batch=2000&offset=0
//   → 转发 18765 /debug/table?name=<t>&batch=&offset=
// 为什么要它：技能规划的评分/费用表都来自游戏 master（skill_data 等），
//   手机上唯一能读 master 的是游戏进程里的 SO，所以从 App 开一个只读代理口。
const fs = require('fs');
const P = process.argv[2];
if (!P) throw new Error('usage: apply_appfix_102.js <NativeEngine.kt>');
let s = fs.readFileSync(P, 'utf8');
if (s.includes('[APP-FIX-102]')) { console.log('already applied'); process.exit(0); }
const anchor = '            p == "/engine" -> json(EngineBridge.statusJson()) // [ENGINE-ANDROID]';
if (!s.includes(anchor)) throw new Error('engine route anchor missing');
const route = [
  '            // [APP-FIX-102] master 表代理（技能规划用）：/api/mdb?t=skill_data&batch=2000&offset=0',
  '            p == "/api/mdb" -> {',
  '                val qs = path.substringAfter(\'?\', "")',
  '                fun qp(k: String): String = qs.split(\'&\')',
  '                    .map { it.split(\'=\', limit = 2) }',
  '                    .firstOrNull { it.size == 2 && it[0] == k }?.get(1) ?: ""',
  '                val t = qp("t")',
  '                val batch = qp("batch").ifEmpty { "2000" }',
  '                val off = qp("offset").ifEmpty { "0" }',
  '                if (t.isEmpty()) json("{\\"ok\\":false,\\"error\\":\\"missing_t\\"}")',
  '                else {',
  '                    val text = httpGetText("/debug/table?name=" + t + "&batch=" + batch + "&offset=" + off)',
  '                    if (text == null) json("{\\"ok\\":false,\\"error\\":\\"so_unreachable\\"}") else json(text)',
  '                }',
  '            }',
].join('\n');
s = s.replace(anchor, anchor + '\n' + route);
fs.writeFileSync(P, s);
console.log('app-fix-102 applied');