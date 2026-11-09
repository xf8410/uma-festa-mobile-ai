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
        @Volatile var decision: String = "",
        @Volatile var decisionJson: org.json.JSONObject? = null,
        @Volatile var restarts: Int = 0,
        // [APP-FIX-105] 引擎健康三连：connected=握手已到；engineError=最近拒帧原因；lastSkip=最近跳帧原因
        @Volatile var connected: Boolean = false,
        @Volatile var engineError: String = "",
        @Volatile var lastSkip: String = ""
    )

    private val slots = ConcurrentHashMap<String, Slot>()

    // [APP-CFG-3294] 用户可调引擎参数（SharedPreferences engine_cfg）：
    //   search_threads = 搜索档 rayon 线程数（默认 4；PC 的 [search].threads 手机版出口）
    //   search_n       = 每候选 rollout 局数（默认 8192；0 = 手写档，不启动搜索进程）
    // 注入通道 = 上游官方环境变量 MATSURI_SEARCH_N / RAYON_NUM_THREADS（不改配置文件）。
    private const val PREFS = "engine_cfg"
    private const val KEY_THREADS = "search_threads"
    private const val KEY_SEARCH_N = "search_n"
    const val DEF_THREADS = 4
    const val DEF_SEARCH_N = 8192
    @Volatile private var appCtx: Context? = null
    @Volatile private var engineFile: File? = null

    fun getThreads(ctx: Context): Int =
        ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getInt(KEY_THREADS, DEF_THREADS).coerceIn(1, 32)

    fun getSearchN(ctx: Context): Int =
        ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getInt(KEY_SEARCH_N, DEF_SEARCH_N).coerceIn(0, 200000)

    /** 保存设置并重启两档引擎（局数/线程只在进程启动时生效） */
    fun applyConfig(ctx: Context, threads: Int, searchN: Int) {
        ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putInt(KEY_THREADS, threads.coerceIn(1, 32))
            .putInt(KEY_SEARCH_N, searchN.coerceIn(0, 200000))
            .apply()
        restart(ctx)
    }

    /** 重启两档引擎进程（设置变更 / 卡死恢复用） */
    @Synchronized
    fun restart(ctx: Context) {
        val app = ctx.applicationContext
        for (t in arrayOf("matsuri", "search")) {
            val s = slot(t)
            try { s.proc?.destroy() } catch (e: Throwable) { }
            s.proc = null
            s.status = "restarting"
            s.lines = 0
            s.restarts = 0
        }
        Thread {
            try {
                val eng = engineFile
                if (eng != null) {
                    startOne(app, eng, "matsuri")
                    startOne(app, eng, "search")
                } else startEngines(app)
            } catch (e: Throwable) {
                slot("matsuri").status = "restart_failed: " + (e.message ?: "")
            }
        }.start()
    }

    /** [AI-WIRE] 决策回调：引擎每出一条 decision 就回调（trainer, 决策JSON）。
     *  NativeEngine 注册后把期望/运气/候选回写进最新帧，浮窗才有数据可渲染。 */
    @Volatile var onDecision: ((trainer: String, decision: org.json.JSONObject) -> Unit)? = null

    @Volatile var frames: Int = 0
        private set
    @Volatile var extractNote: String = ""
        private set

    private fun slot(trainer: String): Slot = slots.getOrPut(trainer) { Slot(trainer) }

    fun rootDir(ctx: Context): File = File(ctx.filesDir, "engine").also { it.mkdirs() }
    fun dataDir(ctx: Context): File = File(rootDir(ctx), "data").also { it.mkdirs() }
    // [APP-FIX-092] 上游 live 口径：--root 是游戏根，帧放 <root>/.portable/PluginData/SendGameStatusPlugin/thisTurn.json
    fun gameRoot(ctx: Context, trainer: String): File =
        File(rootDir(ctx), "root_$trainer").also { it.mkdirs() }
    fun pluginDir(ctx: Context, trainer: String): File =
        File(gameRoot(ctx, trainer), ".portable/PluginData/SendGameStatusPlugin").also { it.mkdirs() }

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
        appCtx = ctx.applicationContext
        engineFile = engine
        if (!engine.canExecute()) engine.setExecutable(true)
        slot("matsuri").status = "extracting_data"
        copyAssetDir(ctx, "engine/data", dataDir(ctx))
        FrameAdapter.loadCardDb(File(dataDir(ctx), "cardDB.json"))
        val marker = File(rootDir(ctx), ".portable")
        if (!marker.exists()) marker.writeText("")
        // [APP-FIX-096] 上游 FileChannel 要求插件目录先存在，否则直接报错退出
        pluginDir(ctx, "matsuri")
        pluginDir(ctx, "search")
        startOne(ctx, engine, "matsuri")
        startOne(ctx, engine, "search")
    }

    private fun startOne(ctx: Context, engine: File, trainer: String) {
        val s = slot(trainer)
        // [APP-CFG-3294] search 档按用户设置启动；search_n = 0 = 手写档（不浪费一个进程）
        if (trainer == "search" && getSearchN(ctx) <= 0) {
            s.status = "disabled: search_n=0"
            return
        }
        s.status = "starting"
        val pb = ProcessBuilder(
            engine.absolutePath,
            "online",
            "--root", gameRoot(ctx, trainer).absolutePath,
            "--trainer", trainer,
            "--json"
        )
        pb.directory(rootDir(ctx))
        val env = pb.environment()
        // [APP-CFG-3294] 上游官方环境变量：RAYON_NUM_THREADS 优先于 [search].threads；
        // MATSURI_SEARCH_N 覆盖 [search].search_n（matsuri-cli online.rs）
        env["RAYON_NUM_THREADS"] = if (trainer == "search") getThreads(ctx).toString() else "1"
        if (trainer == "search") env["MATSURI_SEARCH_N"] = getSearchN(ctx).toString()
        env["MATSURI_ROOT"] = rootDir(ctx).absolutePath
        val p = pb.start()
        s.proc = p
        s.status = "running"
        Thread { drain(p.inputStream) { line -> s.lastLine = line; s.lines++; onEngineLine(line, trainer) } }.start()
        Thread { drain(p.errorStream) { line -> s.lastError = line } }.start()
        Thread {
            val code = try { p.waitFor() } catch (e: Throwable) { -1 }
            if (s.status == "running") {
                s.status = "exited: " + code
                // [APP-CFG-3294] 崩溃自恢复：意外退出自动重拉（最多 3 次，间隔 2s）
                if (s.restarts < 3) {
                    s.restarts++
                    val app = appCtx
                    val eng = engineFile
                    if (app != null && eng != null) {
                        Thread {
                            Thread.sleep(2000)
                            if (s.proc === p) startOne(app, eng, trainer)
                        }.start()
                    }
                }
            }
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
        frames++
        try {
            val frame = FrameAdapter.toFrame(raw).toString()
            for (t in arrayOf("matsuri", "search")) {
                val dir = pluginDir(ctx, t)
                val turn = raw.optInt("turn", 0)
                val chara = raw.optInt("chara_id", 0)
                File(dir, "thisTurn.json").writeText(frame)
            }
        } catch (e: Throwable) {
            slot("matsuri").lastError = "frame_write_failed: " + (e.message ?: "")
        }
    }

    /** 解析引擎 stdout 行：decision=决策；error=拒帧原因（[APP-FIX-105] 透传 UI，不再静默丢）；
     *  info(connected)=启动握手（标记已就绪，区分「进程没起」与「帧被拒」） */
    private fun onEngineLine(line: String, trainer: String) {
        try {
            if (!line.contains("\"type\"")) return
            val o = org.json.JSONObject(line)
            val ty = o.optString("type")
            val s0 = slot(trainer)
            if (ty == "info") {
                when (o.optString("event")) {
                    "connected" -> { s0.connected = true; if (s0.status == "running" || s0.status == "starting") s0.status = "connected" }
                    // 跳帧（重复帧 / 事件帧无数据 / 结算中间态）：记状态不进帧——重复帧是常态
                    "frame_skipped" -> s0.lastSkip = o.optString("reason", "")
                }
                return
            }
            if (ty == "error") {
                val msg = o.optString("message", o.optString("reason", ""))
                if (msg.isNotEmpty()) {
                    s0.engineError = msg
                    s0.lastError = msg
                    // 走决策通道回写帧：UI 显示「引擎：原因」而不是永远「等待引擎决策」
                    val d = org.json.JSONObject()
                    d.put("trainer", trainer)
                    d.put("kind", "engine_error")
                    d.put("error", msg)
                    try { onDecision?.invoke(trainer, d) } catch (e: Throwable) { }
                }
                return
            }
            if (ty != "decision") return
            s0.engineError = "" // 出新决策 = 上一帧的拒绝已翻篇
            val ex = o.optJSONObject("scenario_extra")
            // [AI-WIRE] 直接组 JSONObject（原来是拼字符串），顺带回调给 NativeEngine 回写帧
            val d = org.json.JSONObject()
            d.put("trainer", trainer)
            d.put("turn", o.optInt("turn", 0))
            d.put("kind", o.optString("decision_kind", ""))
            d.put("score", o.optDouble("score", 0.0))
            d.put("action_index", o.optInt("action_index", 0))
            d.put("expected_score", ex?.optInt("expected_score", 0) ?: 0)
            d.put("expected_stdev", ex?.optInt("expected_stdev", 0) ?: 0)
            d.put("expected_rank", ex?.optString("expected_rank", "") ?: "")
            d.put("baseline", ex?.optDouble("baseline", 0.0) ?: 0.0)
            d.put("descriptions", o.optJSONArray("candidate_descriptions") ?: org.json.JSONArray())
            d.put("scores", o.optJSONArray("candidate_scores") ?: org.json.JSONArray())
            d.put("detail", ex?.optJSONArray("candidate_detail") ?: org.json.JSONArray())
            val s = slot(trainer)
            s.decision = d.toString()
            s.decisionJson = d
            try { onDecision?.invoke(trainer, d) } catch (e: Throwable) { }
        } catch (e: Throwable) {
        }
    }

    private fun slotJson(s: Slot): String {
        val sb = StringBuilder()
        sb.append("{")
        sb.append("\"status\":").append(q(s.status)).append(",")
        sb.append("\"lines\":").append(s.lines).append(",")
        sb.append("\"connected\":").append(s.connected).append(",")
        sb.append("\"engine_error\":").append(q(trim(s.engineError))).append(",")
        sb.append("\"last_skip\":").append(q(trim(s.lastSkip))).append(",")
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
        appCtx?.let { c ->
            sb.append("\"threads\":").append(getThreads(c)).append(",")
            sb.append("\"search_n\":").append(getSearchN(c)).append(",")
        }
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