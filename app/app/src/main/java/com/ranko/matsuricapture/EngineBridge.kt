package com.ranko.matsuricapture

import android.content.Context
import java.io.BufferedReader
import java.io.File
import java.io.InputStream
import java.io.InputStreamReader

/**
 * [ENGINE-ANDROID] 把上游 umaai 引擎（libmatsuri_engine.so，matsuri 二进制）内置进 App 跑。
 *
 * 分工：游戏进程里的 hachimi SO 只读内存 / 推帧；模拟与蒙特卡洛全在这里（App 进程），
 * 绝不在游戏进程里算，避免卡死。
 *
 * 引擎要求：CWD 下要有 data/（DATA_ROOT="data" 是相对路径），--root 指向帧目录，
 * 帧文件名形如 game{局号}_turn{回合}.json。
 */
object EngineBridge {
    @Volatile private var proc: Process? = null

    @Volatile var status: String = "not_started"
        private set
    @Volatile var lastLine: String = ""
        private set
    @Volatile var lastError: String = ""
        private set
    @Volatile var lines: Int = 0
        private set
    @Volatile var frames: Int = 0
        private set

    fun rootDir(ctx: Context): File = File(ctx.filesDir, "engine").also { it.mkdirs() }
    fun framesDir(ctx: Context): File = File(rootDir(ctx), "frames").also { it.mkdirs() }
    fun dataDir(ctx: Context): File = File(rootDir(ctx), "data").also { it.mkdirs() }

    fun init(ctx: Context) {
        val app = ctx.applicationContext
        if (proc != null) return
        Thread {
            try {
                startEngine(app)
            } catch (e: Throwable) {
                status = "start_failed: " + (e.message ?: e.javaClass.simpleName)
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

    private fun startEngine(ctx: Context) {
        val engine = File(ctx.applicationInfo.nativeLibraryDir, "libmatsuri_engine.so")
        if (!engine.exists()) {
            status = "engine_missing"
            return
        }
        if (!engine.canExecute()) engine.setExecutable(true)
        status = "extracting_data"
        copyAssetDir(ctx, "engine/data", dataDir(ctx))
        val marker = File(rootDir(ctx), ".portable")
        if (!marker.exists()) marker.writeText("")
        status = "starting"
        val pb = ProcessBuilder(
            engine.absolutePath,
            "online",
            "--root", framesDir(ctx).absolutePath,
            "--json",
            "--trainer", "search"
        )
        pb.directory(rootDir(ctx))
        val env = pb.environment()
        env["RAYON_NUM_THREADS"] = "4"
        env["MATSURI_ROOT"] = rootDir(ctx).absolutePath
        val p = pb.start()
        proc = p
        status = "running"
        Thread { drain(p.inputStream) { s -> lastLine = s; lines++ } }.start()
        Thread { drain(p.errorStream) { s -> lastError = s } }.start()
        Thread {
            val code = try { p.waitFor() } catch (e: Throwable) { -1 }
            if (status.startsWith("running")) status = "exited: " + code
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
            // 进程结束时流会断，忽略
        }
    }

    /** 每收到一帧 /summary 就落一份帧文件给引擎 */
    fun onSummary(ctx: Context, raw: org.json.JSONObject) {
        try {
            val turn = raw.optInt("turn", 0)
            val chara = raw.optInt("chara_id", 0)
            val f = File(framesDir(ctx), "game" + chara + "_turn" + turn + ".json")
            f.writeText(raw.toString())
            frames++
        } catch (e: Throwable) {
            lastError = "frame_write_failed: " + (e.message ?: "")
        }
    }

    fun statusJson(): String {
        val sb = StringBuilder()
        sb.append("{")
        sb.append("\"status\":").append(q(status)).append(",")
        sb.append("\"frames\":").append(frames).append(",")
        sb.append("\"lines\":").append(lines).append(",")
        sb.append("\"last_line\":").append(q(trim(lastLine))).append(",")
        sb.append("\"last_error\":").append(q(trim(lastError)))
        sb.append("}")
        return sb.toString()
    }

    private fun trim(s: String): String = if (s.length > 1500) s.substring(s.length - 1500) else s

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