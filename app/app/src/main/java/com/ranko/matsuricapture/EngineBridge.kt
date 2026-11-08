package com.ranko.matsuricapture

import android.content.Context
import java.io.BufferedReader
import java.io.File
import java.io.InputStream
import java.io.InputStreamReader
import java.util.concurrent.ConcurrentHashMap

/**
 * [ENGINE-ANDROID] 内置上游 umaai 引擎（libmatsuri_engine.so = matsuri 二进制），在 App 进程里跑。
 *
 * 分工：游戏进程里的 hachimi SO 只读内存 / 推帧；模拟与蒙特卡洛全在这里，绝不在游戏进程里算。
 *
 * 双档（对齐 PC 的接线）：
 *  - `matsuri`：手写训练员（守门链 + 打分表 + 教诲价值矩阵），确定性、秒级 → 主决策
 *  - `search` ：搜索档（MCTS，[search].search_n 默认 8192）→ 期望分 / ±σ / 档次
 * 两档各自一个子进程、各自一个帧目录；同一帧同时喂两档。
 *
 * [ENGINE-ADAPTER] [APP-FIX-088] 本文件已包含 086/088 的补丁内容（跳过那两个脚本的补丁）。
 */
object EngineBridge {
    data class Slot(
        val trainer: String,
        @Volatile var proc: Process? = null,
        @Volatile var status: String = "not_started",
        @Volatile var lastLine: String = "",
        @Volatile var lastError: String = "",
        @Volatile var lines: Int = 0,
        @Volatile var decision: String = ""
    )

    private val slots = ConcurrentHashMap<String, Slot>()

    @Volatile var frames: Int = 0
        private set
    @Volatile var extractNote: String = ""
        private set

    private fun slot(trainer: String): Slot = slots.getOrPut(trainer) { Slot(trainer) }

    fun rootDir(ctx: Context): File = File(ctx.filesDir, "engine").also { it.mkdirs() }
    fun dataDir(ctx: Context): File = File(rootDir(ctx), "data").also { it.mkdirs() }
    fun framesDir(ctx: Context, trainer: String): File =
        File(rootDir(ctx), "frames_$trainer").also { it.mkdirs() }

    fun init(ctx: Context) {
        val app = ctx.applicationContext
        if (slot("matsuri").proc != null || slot("search").proc != null) return
        Thread {
            try {
                startEngines(app)
            } catch (e: Throwable) {
                slot("matsuri").status = "start_failed: " + (e.message ?: e.javaClass.simpleName)
            }
        }.start()
    }

    private fun copyAssetDir(ctx: Context, assetPath: String, dst: File) {
        val list = try { ctx.assets.list(assetPath) } catch (e: Throwable) { null } ?: return
        dst.mkdirs()
        for (name in list) {
            val child = assetPath + "/" + name
            val sub = try { ctx.assets.list(child) } catch (e: Throwable) { null }
            if (sub != null && sub.isNotEmpty()) {
                copyAssetDir(ctx, child, File(dst, name))
            } else {
                val f = File(dst, name)
                if (!f.exists() || f.length() == 0L) {
                    f.parentFile?.mkdirs()
                    ctx.assets.open(child).use { inp -> f.outputStream().use { out -> inp.copyTo(out) } }
                }
            }
        }
    }

    private fun resolveEngine(ctx: Context): File? {
        val direct = File(ctx.applicationInfo.nativeLibraryDir, "libmatsuri_engine.so")
        if (direct.exists()) return direct
        extractNote = "engine_not_in_native_lib_dir"
        return null
    }

    private fun startEngines(ctx: Context) {
        val engine = resolveEngine(ctx)
        if (engine == null) {
            slot("matsuri").status = "engine_missing"
            slot("search").status = "engine_missing"
            return
        }
        if (!engine.canExecute()) engine.setExecutable(true)
        slot("matsuri").status = "extracting_data"
        copyAssetDir(ctx, "engine/data", dataDir(ctx))
        FrameAdapter.loadCardDb(File(dataDir(ctx), "cardDB.json"))
        val marker = File(rootDir(ctx), ".portable")
        if (!marker.exists()) marker.writeText("")
        startOne(ctx, engine, "matsuri")
        startOne(ctx, engine, "search")
    }

    private fun startOne(ctx: Context, engine: File, trainer: String) {
        val s = slot(trainer)
        s.status = "starting"
        val pb = ProcessBuilder(
            engine.absolutePath,
            "online",
            "--root", framesDir(ctx, trainer).absolutePath,
            "--trainer", trainer,
            "--json"
        )
        pb.directory(rootDir(ctx))
        val env = pb.environment()
        env["RAYON_NUM_THREADS"] = if (trainer == "search") "4" else "1"
        env["MATSURI_ROOT"] = rootDir(ctx).absolutePath
        val p = pb.start()
        s.proc = p
        s.status = "running"
        Thread { drain(p.inputStream) { line -> s.lastLine = line; s.lines++; onEngineLine(line, trainer) } }.start()
        Thread { drain(p.errorStream) { line -> s.lastError = line } }.start()
        Thread {
            val code = try { p.waitFor() } catch (e: Throwable) { -1 }
            if (s.status == "running") s.status = "exited: " + code
        }.start()
    }

    private fun drain(input: InputStream, onLine: (String) -> Unit) {
        try {
            BufferedReader(InputStreamReader(input)).use { r ->
                while (true) {
                    val line = r.readLine() ?: break
                    if (line.isNotEmpty()) onLine(line)
                }
            }
        } catch (e: Throwable) {
        }
    }

    /** 每收到一帧 /summary 就转成引擎帧，同时喂给两档 */
    fun onSummary(ctx: Context, raw: org.json.JSONObject) {
        try {
            val frame = FrameAdapter.toFrame(raw).toString()
            for (t in arrayOf("matsuri", "search")) {
                val dir = framesDir(ctx, t)
                val turn = raw.optInt("turn", 0)
                val chara = raw.optInt("chara_id", 0)
                File(dir, "game" + chara + "_turn" + turn + ".json").writeText(frame)
            }
            frames++
        } catch (e: Throwable) {
            slot("matsuri").lastError = "frame_write_failed: " + (e.message ?: "")
        }
    }

    /** 解析引擎 stdout 的决策行（type=decision） */
    private fun onEngineLine(line: String, trainer: String) {
        try {
            if (!line.contains("\"type\"")) return
            val o = org.json.JSONObject(line)
            if (o.optString("type") != "decision") return
            val ex = o.optJSONObject("scenario_extra")
            val d = StringBuilder()
            d.append("{")
            d.append("\"trainer\":\"").append(trainer).append("\",")
            d.append("\"turn\":").append(o.optInt("turn", 0)).append(",")
            d.append("\"score\":").append(o.optDouble("score", 0.0)).append(",")
            d.append("\"action_index\":").append(o.optInt("action_index", 0)).append(",")
            d.append("\"expected_score\":").append(ex?.optInt("expected_score", 0) ?: 0).append(",")
            d.append("\"expected_stdev\":").append(ex?.optInt("expected_stdev", 0) ?: 0).append(",")
            d.append("\"expected_rank\":\"").append(ex?.optString("expected_rank", "") ?: "").append("\",")
            d.append("\"baseline\":").append(ex?.optDouble("baseline", 0.0) ?: 0.0).append(",")
            d.append("\"descriptions\":").append(o.optJSONArray("candidate_descriptions")?.toString() ?: "[]").append(",")
            d.append("\"scores\":").append(o.optJSONArray("candidate_scores")?.toString() ?: "[]").append(",")
            d.append("\"detail\":").append(ex?.optJSONArray("candidate_detail")?.toString() ?: "[]")
            d.append("}")
            slot(trainer).decision = d.toString()
        } catch (e: Throwable) {
        }
    }

    private fun slotJson(s: Slot): String {
        val sb = StringBuilder()
        sb.append("{")
        sb.append("\"status\":").append(q(s.status)).append(",")
        sb.append("\"lines\":").append(s.lines).append(",")
        sb.append("\"last_line\":").append(q(trim(s.lastLine))).append(",")
        sb.append("\"last_error\":").append(q(trim(s.lastError))).append(",")
        sb.append("\"decision\":").append(if (s.decision.isEmpty()) "null" else s.decision)
        sb.append("}")
        return sb.toString()
    }

    fun statusJson(): String {
        val sb = StringBuilder()
        sb.append("{")
        sb.append("\"frames\":").append(frames).append(",")
        sb.append("\"engine_note\":").append(q(extractNote)).append(",")
        sb.append("\"hand\":").append(slotJson(slot("matsuri"))).append(",")
        sb.append("\"search\":").append(slotJson(slot("search")))
        sb.append("}")
        return sb.toString()
    }

    private fun trim(s: String): String = if (s.length > 1200) s.substring(s.length - 1200) else s

    private fun q(s: String): String {
        val out = StringBuilder("\"")
        for (ch in s) {
            when (ch) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                else -> if (ch < ' ') out.append('?') else out.append(ch)
            }
        }
        out.append("\"")
        return out.toString()
    }
}