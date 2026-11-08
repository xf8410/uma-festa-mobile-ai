#!/usr/bin/env node
// [APP-FIX-092] 修「引擎起不来」：上游 live 模式的 --root 是**游戏根**，引擎自己拼
//   <root>/.portable/PluginData/SendGameStatusPlugin 并监看 thisTurn.json。
//   我们之前把 --root 指到帧目录、又没建插件目录 → 「小黑板数据目录不存在」，引擎秒退。
// 同时把 frames 计数改成按收到 /summary 计（转换失败也计数，并单独记 adapter 错误）。
const fs = require('fs');
const P = process.argv[2];
if (!P) throw new Error('usage: apply_appfix_092.js <EngineBridge.kt>');
let s = fs.readFileSync(P, 'utf8');
if (s.includes('[APP-FIX-092]')) { console.log('already applied'); process.exit(0); }
const once = (a, b) => {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error('anchor count=' + n + ' for: ' + JSON.stringify(a.slice(0, 60)));
  s = s.split(a).join(b);
};

// 1) 目录：gameRoot / pluginDir
once(
  '    fun framesDir(ctx: Context, trainer: String): File =\n        File(rootDir(ctx), "frames_$trainer").also { it.mkdirs() }',
  '    // [APP-FIX-092] 上游 live 口径：--root 是游戏根，帧放 <root>/.portable/PluginData/SendGameStatusPlugin/thisTurn.json\n' +
  '    fun gameRoot(ctx: Context, trainer: String): File =\n        File(rootDir(ctx), "root_$trainer").also { it.mkdirs() }\n' +
  '    fun pluginDir(ctx: Context, trainer: String): File =\n' +
  '        File(gameRoot(ctx, trainer), ".portable/PluginData/SendGameStatusPlugin").also { it.mkdirs() }'
);

// 2) 引擎参数换成游戏根
once(
  '            "--root", framesDir(ctx, trainer).absolutePath,',
  '            "--root", gameRoot(ctx, trainer).absolutePath,'
);

// 3) 帧写进插件目录（thisTurn.json）
once(
  '                val dir = framesDir(ctx, t)',
  '                val dir = pluginDir(ctx, t)'
);
once(
  '                File(dir, "game" + chara + "_turn" + turn + ".json").writeText(frame)',
  '                File(dir, "thisTurn.json").writeText(frame)'
);

// 4) frames 计数：收到就算，转换失败单独记
once(
  '        try {\n            val frame = FrameAdapter.toFrame(raw).toString()',
  '        frames++\n        try {\n            val frame = FrameAdapter.toFrame(raw).toString()'
);
once(
  '            frames++\n        } catch (e: Throwable) {\n            slot("matsuri").lastError = "frame_write_failed: " + (e.message ?: "")\n        }',
  '        } catch (e: Throwable) {\n            slot("matsuri").lastError = "frame_write_failed: " + (e.message ?: "")\n        }'
);

fs.writeFileSync(P, s);
console.log('app-fix-092 applied');