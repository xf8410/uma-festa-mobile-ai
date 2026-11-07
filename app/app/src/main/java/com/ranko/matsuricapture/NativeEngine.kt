package com.ranko.matsuricapture

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 18766 接收端 —— 纯 Kotlin 实现，不依赖 cargo-ndk 预编译的 libmatsuri_capture.so。
 *
 * 【与 SO 插件的对齐】
 * 传输层：`libhachimi_ura.so` 的 push_to_app() 把 read_summary() 的 /summary JSON
 *   以 `POST /data` 推到 127.0.0.1:18766（src/lib.rs:878 / 剧本15 线 :6631）。
 * 字段层：SO 的 /summary 是**深层嵌套**（`stats.speed`、`festa.festa_info` …），
 *   而面板吃的是 matsuri-capture 的**扁平帧**（`five` / `vital` / `skill_point` …）。
 *   本文件按 matsuri-capture/src/lib.rs 的 Frame::build() 逐项做归一化，缺值一律 -1。
 *
 * 【SO 诊断】festa 缺失时不再静默显示「—」，而是给出 need_so_rebuild，
 *   因为「/summary 内嵌 festa」只能在 SO 侧修，换手机 App 代替不了。
 *
 * 本文件只负责接收与字段归一化，不改动游戏结果画面的任何显示逻辑。
 *
 * 【接线方向（勿再写反）】
 *   SO（游戏进程内）hook 数据 → 在 18765 提供 /summary（数据出口，随持续育成不断更新）
 *     ├─ 推送通道：SO 把 /summary 以 POST /data 推到 18766      （SO 是唯一推送方）
 *     └─ 拉取通道：18766 周期性主动 GET 18765 /summary         （pullLoop，持续跑）
 *   18766 全程只 LISTEN/ACCEPT + GET，绝不对外 POST；两端都当推送方就没人收。
 *   两条通道收到的 body 一律 normalize 成育成属性帧
 *   （stats→五维/体力/PT/干劲，festa→稽古/教诲/角标/人头/设施）。
 */
object NativeEngine {

    private val running = AtomicBoolean(false)
    private val gate = Any()
    private val frames = ArrayList<JSONObject>()
    @Volatile private var latest: JSONObject? = null
    @Volatile private var lastAt = 0L
    private var sessionDir: File? = null
    private var appContext: Context? = null
    /** /debug/festa_probe 是否可用；null = 18765 不可达、尚未探明 */
    @Volatile private var soProbeOk: Boolean? = null
    /** 18765 /health 是否可达（SO 进程是否活着） */
    @Volatile private var soAlive: Boolean = false
    /** 冷启动时从 frames.jsonl 恢复的帧数 */
    @Volatile private var archivedFrames: Int = 0
    /** 当前 latest 来源：push / pull / archive / none */
    @Volatile private var latestSource: String = "none"
    /** 链路诊断：收到的推送帧数 / 主动拉取落库帧数 / 最近拉取成功时刻 / SO 最近错误 */
    @Volatile private var pushRecv: Int = 0
    @Volatile private var pullRecv: Int = 0
    @Volatile private var lastPullOkAtMs: Long = 0L
    @Volatile private var lastSummaryError: String = ""

    private const val UNKNOWN = -1L
    /** 主动拉取检查周期：只检查「推送是否静默」，不必然发起 HTTP 请求。 */
    private const val PULL_TICK_MS = 2000L
    /** 推送静默多久才触发一次兜底拉取，同时也是两次兜底拉取之间的最小间隔。
     *  必须大于 SO push_loop 的 FALLBACK_READ_MS(15s)：SO 的 /summary 有 3s 结果缓存，
     *  缓存一过期就会触发一次 IL2CPP 全量真读(festa hex dump)，正是 SIGSEGV 高危路径。
     *  若手机端高频无条件拉，会把 SO「事件驱动 + 15s 兜底」降频后的真读频率又拉回高频，
     *  导致游戏卡顿/崩溃。因此主动拉取只在 SO 推送静默超过本阈值时兜底接管。 */
    private const val PULL_STALE_MS = 20000L
    private val FIVE_KEYS = arrayOf("speed", "stamina", "power", "guts", "wiz")

    fun start(bind: String, dir: String, ctx: Context? = null): Boolean {
        if (ctx != null) appContext = ctx.applicationContext
        if (running.get()) return true
        return try {
            val i = bind.lastIndexOf(':')
            val host = if (i > 0) bind.substring(0, i) else "127.0.0.1"
            val port = if (i > 0) bind.substring(i + 1).toInt() else 18766
            val server = ServerSocket(port, 32, InetAddress.getByName(host))
            sessionDir = File(dir).apply { mkdirs() }
            restoreFromArchive()
            running.set(true)
            Thread({ loop(server) }, "matsuri-18766").apply { isDaemon = true }.start()
            Thread({ probeLoop() }, "matsuri-so-probe").apply { isDaemon = true }.start()
            Thread({ pullLoop() }, "matsuri-so-pull").apply { isDaemon = true }.start()
            true
        } catch (e: Exception) {
            false
        }
    }

    fun isRunning(): Boolean = running.get()

    /**
     * 低频判活 + 「按需」探探针。
     *
     * v0.4.2 接线同步：与 perf-opt 版 SO 的事件驱动推送对齐，避免手机端把
     * SO 刚降下来的全量读频率又拉回去。
     *
     *  - `/health` 是纯静态 JSON（只拼版本与端点清单，不读 IL2CPP），每 3s 判活无害。
     *  - `/debug/festa_probe` 是**重型**端点：直读 IL2CPP 内存、hex dump
     *    CommandGainActGaugeArray / CommandInfoArray / EvaluationInfoArray 三个数组，
     *    且完全不走 CACHED_SUMMARY。旧实现每 3s 打一次 = 20 次/分全量读，
     *    等于把 SO perf-opt「事件驱动 + 15s 兜底」的降频成果完全抵消，
     *    而这正是 SIGSEGV 高危路径（只读一次就可能触发游戏保护）。
     *
     * 因此改为：探针能力是 SO 编译期属性、不会随帧变化，只在
     *  ① 首次判活 ② SO 掉线后重新上线 时各探一次，之后复用缓存结果。
     *  SO 没起时置 null（不误报「不可用」，下次上线重探）。
     */
    private fun probeLoop() {
        var lastAlive = false
        while (running.get()) {
            soAlive = try {
                val c = URL("http://127.0.0.1:18765/health")
                    .openConnection() as HttpURLConnection
                c.connectTimeout = 1200
                c.readTimeout = 1500
                c.responseCode == 200
            } catch (e: Exception) {
                false
            }
            val reconnected = soAlive && !lastAlive
            if (!soAlive) {
                // SO 未就绪：清掉探针结论，等重新上线再探，不误报「需重编 SO」
                soProbeOk = null
            } else if (reconnected || soProbeOk == null) {
                // 仅在首次 / 重连时探一次重型端点
                soProbeOk = try {
                    val c = URL("http://127.0.0.1:18765/debug/festa_probe")
                        .openConnection() as HttpURLConnection
                    c.connectTimeout = 1500
                    c.readTimeout = 2500
                    if (c.responseCode == 200) true else false
                } catch (e: Exception) {
                    false
                }
            }
            lastAlive = soAlive
            try { Thread.sleep(3000) } catch (ignored: InterruptedException) { return }
        }
    }

    /**
     * 持续主动拉取 18765 的 /summary —— 游戏是持续育成的，这条通道必须一直存在。
     *
     * 接线角色：SO 是唯一推送方(POST /data)，18766 只 LISTEN + GET，绝不往外 POST。
     *   - 主通道：SO push_loop「数据变化 800ms 去抖即推 + 15s 兜底心跳」，负责把
     *     持续育成的最新帧推到 18766。推送正常时 lastAt 常新，本循环不发起任何请求，
     *     零额外 IL2CPP 真读，SO 的降频成果完整保留。
     *   - 兜底通道：一旦推送静默超过 PULL_STALE_MS(20s，> SO 15s 兜底)，说明
     *     push_enabled 被关 / 端口配错 / 推送丢失，此时主动 GET /summary 接管，
     *     保证「就算 SO 不推，18766 也一直能把游戏内育成属性拉进来」。
     *
     * 拉取本身取原文做 hash 去重，内容不变不落库；且两次兜底拉取最小间隔同为
     * PULL_STALE_MS，SO 不可达时最坏 20s 一次请求，绝不打爆游戏进程。
     */
    private fun pullLoop() {
        var lastHash: Int? = null
        var lastAttempt = 0L
        while (running.get()) {
            val now = System.currentTimeMillis()
            val silent = lastAt == 0L || now - lastAt >= PULL_STALE_MS
            if (silent && now - lastAttempt >= PULL_STALE_MS) {
                lastAttempt = now
                val text = httpGetText("/summary")
                if (text == null) {
                    lastSummaryError = "18765_unreachable"
                } else {
                    val jo = try { JSONObject(text) } catch (ignored: Exception) { null }
                    if (jo == null) {
                        lastSummaryError = "summary_not_json"
                    } else if (jo.has("error")) {
                        // ★ v0.7.4：SO v3.28.18 起 error JSON 带 last_step（崩溃前最后读取步骤），
                        // 拼进诊断——真机定位段错误点不用再拉 /debug/laststep
                        val step = jo.optString("last_step", "")
                        lastSummaryError = jo.optString("error", "error") +
                            (if (step.isNotEmpty()) "@$step" else "")
                    } else {
                        // /summary 可达即证明 SO 活着；只置 true，判死交给 probeLoop 的 /health
                        soAlive = true
                        val h = text.hashCode()
                        if (lastHash == null || h != lastHash) {
                            lastHash = h
                            pullRecv++
                            lastPullOkAtMs = now
                            lastSummaryError = ""
                            store(normalize(jo, null, "pull"))
                        }
                    }
                }
            }
            try { Thread.sleep(PULL_TICK_MS) } catch (ignored: InterruptedException) { return }
        }
    }

    private fun loop(server: ServerSocket) {
        try {
            while (running.get()) {
                val client = server.accept()
                Thread({ handle(client) }, "matsuri-http").apply { isDaemon = true }.start()
            }
        } catch (ignored: Exception) {
        } finally {
            running.set(false)
            try { server.close() } catch (ignored: Exception) {}
        }
    }

    private fun handle(client: Socket) {
        try {
            client.soTimeout = 15000
            val input = client.getInputStream().buffered()
            val head = StringBuilder()
            var tail = ""
            while (head.length < 65536) {
                val c = input.read()
                if (c < 0) return
                head.append(c.toChar())
                tail += c.toChar()
                if (tail.length > 4) tail = tail.substring(1)
                if (tail == "\r\n\r\n") break
            }
            val lines = head.toString().split("\r\n")
            val req = lines[0].split(" ")
            val method = req.getOrElse(0) { "GET" }
            val path = req.getOrElse(1) { "/" }
            var length = 0
            for (i in 1 until lines.size) {
                val k = lines[i].indexOf(':')
                if (k > 0 && lines[i].substring(0, k).trim().equals("content-length", true)) {
                    length = lines[i].substring(k + 1).trim().toIntOrNull() ?: 0
                }
            }
            val buf = ByteArray(length)
            if (length > 0) {
                var off = 0
                while (off < length) {
                    val r = input.read(buf, off, length - off)
                    if (r < 0) break
                    off += r
                }
            }
            val body = String(buf, StandardCharsets.UTF_8)
            write(client, route(method, path, body))
        } catch (ignored: Exception) {
        } finally {
            try { client.close() } catch (ignored: Exception) {}
        }
    }

    private data class Resp(val status: String, val type: String, val body: ByteArray)

    private fun json(text: String): Resp =
        Resp("200 OK", "application/json; charset=utf-8", text.toByteArray(StandardCharsets.UTF_8))

    private fun route(method: String, path: String, body: String): Resp {
        val p = path.substringBefore('?')
        if (method == "OPTIONS") return json("{}")
        return when {
            method == "POST" && p == "/data" -> { ingest(body, "push"); json("{\"ok\":true}") }
            p == "/api/health" -> json(healthJson().toString())
            p == "/api/snapshot" -> json(snapshot().toString())
            p == "/api/frames" -> json(framesJson(path).toString())
            p == "/api/export" -> Resp("200 OK", "application/x-ndjson; charset=utf-8", export())
            method == "POST" && p == "/api/export_file" -> json(exportFile().toString())
            p == "/api/pull" -> json(pull().toString())
            p == "/float" || p == "/float.html" -> asset("float.html", "text/html; charset=utf-8")
            p == "/support_cards.json" -> asset("support_cards.json", "application/json; charset=utf-8")
            p == "/" || p == "/index.html" -> html()
            else -> Resp("404 Not Found", "application/json; charset=utf-8",
                "{\"error\":\"not found\"}".toByteArray(StandardCharsets.UTF_8))
        }
    }

    private fun write(client: Socket, r: Resp) {
        val out = client.getOutputStream()
        val header = "HTTP/1.1 ${r.status}\r\n" +
            "Content-Type: ${r.type}\r\n" +
            "Content-Length: ${r.body.size}\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
            "Access-Control-Allow-Headers: Content-Type\r\n" +
            "Cache-Control: no-store\r\n" +
            "Connection: close\r\n\r\n"
        out.write(header.toByteArray(StandardCharsets.UTF_8))
        out.write(r.body)
        out.flush()
    }

    // ───────────────────────── 字段归一化（对齐 SO /summary） ─────────────────────────

    private fun iv(o: JSONObject?, key: String): Long {
        if (o == null) return UNKNOWN
        return when (val v = o.opt(key)) {
            is Number -> v.toLong()
            // SO 组包的布尔字段（is_shining/is_unique_active/is_tips_event）是 JSON true/false
            is Boolean -> if (v) 1L else 0L
            is String -> v.toLongOrNull() ?: UNKNOWN
            else -> UNKNOWN
        }
    }

    private fun sv(o: JSONObject?, key: String): String = o?.optString(key, "") ?: ""

    /** 兼容「裸数组」与插件常见的 {len, list:[...]} 包装 */
    private fun listOf(o: JSONObject?, key: String): JSONArray {
        if (o == null) return JSONArray()
        return when (val v = o.opt(key)) {
            is JSONArray -> v
            is JSONObject -> v.optJSONArray("list") ?: JSONArray()
            else -> JSONArray()
        }
    }

    /** 与 matsuri-capture/src/lib.rs::Frame::build 同口径；extra = /debug/festa_probe 响应 */
    private fun normalize(summary: JSONObject, extra: JSONObject?, source: String): JSONObject {
        val festa: JSONObject? = when {
            summary.optJSONObject("festa") != null -> summary.optJSONObject("festa")
            extra?.optJSONObject("festa") != null -> extra.optJSONObject("festa")
            extra != null && extra.length() > 0 -> extra
            else -> null
        }
        val stats = summary.optJSONObject("stats")
        val maxStats = summary.optJSONObject("max_stats")
        val five = JSONArray()
        val maxFive = JSONArray()
        FIVE_KEYS.forEach { five.put(iv(stats, it)); maxFive.put(iv(maxStats, it)) }

        val acts = JSONArray()
        val actList = listOf(festa, "acts")
        for (i in 0 until actList.length()) {
            val a = actList.optJSONObject(i) ?: continue
            val o = JSONObject()
            arrayOf("act_type", "command_id", "gauge", "need_gauge", "level", "state",
                "advice_id", "friend_outing").forEach { o.put(it, iv(a, it)) }
            o.put("name", sv(a, "name"))
            o.put("name_src", sv(a, "name_src"))
            acts.put(o)
        }
        val advice = JSONArray()
        val adList = listOf(festa, "advice")
        for (i in 0 until adList.length()) {
            val a = adList.optJSONObject(i) ?: continue
            advice.put(JSONObject().put("advice_id", iv(a, "advice_id"))
                .put("fusion_advice_id", iv(a, "fusion_advice_id")))
        }
        val cps = JSONArray()
        val cpList = listOf(festa, "checkpoints")
        for (i in 0 until cpList.length()) {
            val c = cpList.optJSONObject(i) ?: continue
            cps.put(JSONObject().put("schedule_id", iv(c, "schedule_id"))
                .put("result_type", iv(c, "result_type")))
        }
        val info = festa?.optJSONObject("festa_info")

        // ── v0.4.0：接住 SO 已推、旧版丢弃的三类 festa 字段 ──────────────────
        // 依据 umaai-matsuri/docs/plan/online_wiring.md §2 #21 / §3.7：
        // command_info[].is_upper_training_event_occurred = 追加稽古掷中（2026-11-04 已定位）。
        // 任一位为真即置 kensan_pending；predict_len 是槽增益预测数组的条目数。
        val commandInfo = JSONArray()
        val ciList = listOf(festa, "command_info")
        var kensanPending = false
        for (i in 0 until ciList.length()) {
            val c = ciList.optJSONObject(i) ?: continue
            val upper = iv(c, "is_upper_training_event_occurred")
            if (upper > 0) kensanPending = true
            commandInfo.put(JSONObject()
                .put("command_type", iv(c, "command_type"))
                .put("command_id", iv(c, "command_id"))
                .put("predict_len", iv(c, "predict_len"))
                .put("is_upper_training_event_occurred", upper))
        }
        // gain_gauges：按训练位的槽增益预测（predict 是内存探测 hex，不作数值收益）
        val gainGauges = JSONArray()
        val ggList = listOf(festa, "gain_gauges")
        for (i in 0 until ggList.length()) {
            val g = ggList.optJSONObject(i) ?: continue
            gainGauges.put(JSONObject()
                .put("command_type", iv(g, "command_type"))
                .put("predict_len", iv(g, "predict_len")))
        }
        // evaluation_info：SO 只推原始内存 hex，target_id/chara_id/act_type 布局
        // 未在真机实测（online_wiring.md ❓G5）。这里只如实透传条数与解析状态，
        // 绝不把 hex 猜成人名 —— 担当卡姓名字段状态由 evaluation_parsed=false 表达。
        val evList = listOf(festa, "evaluation_info")
        val evaluationCount = evList.length()

        // ── v0.7.2：接住 SO /summary 已推、旧版丢弃的两块真实数据 ─────────────
        // trainings[].partners[]：人头全字段（partner_id/support_card_id/current_bond
        //   /is_shining/is_unique_active/bond_threshold/support_card_type/is_tips_event
        //   /partner_type/name），依据 SO lib.rs partners_json 组包（v3.24.x）。
        // support_cards[]：装备卡组（position/support_card_id/chara_id/kizuna/
        //   limit_break_count/exp/rental_type），依据 SO lib.rs sc_json 组包。
        val trainings = JSONArray()
        val trList = listOf(summary, "trainings")
        for (i in 0 until trList.length()) {
            val t = trList.optJSONObject(i) ?: continue
            val o = JSONObject()
            o.put("command_id", iv(t, "command_id"))
            o.put("cmd_type", iv(t, "cmd_type"))
            o.put("name", sv(t, "name"))
            o.put("is_enable", iv(t, "is_enable"))
            o.put("failure_rate", iv(t, "failure_rate"))
            o.put("heads", iv(t, "heads"))
            o.put("shining", iv(t, "shining"))
            val partners = JSONArray()
            val pList = t.optJSONArray("partners") ?: JSONArray()
            for (j in 0 until pList.length()) {
                val p = pList.optJSONObject(j) ?: continue
                partners.put(JSONObject()
                    .put("partner_id", iv(p, "partner_id"))
                    .put("support_card_id", iv(p, "support_card_id"))
                    .put("current_bond", iv(p, "current_bond"))
                    .put("is_shining", iv(p, "is_shining"))
                    .put("is_unique_active", iv(p, "is_unique_active"))
                    .put("bond_threshold", iv(p, "bond_threshold"))
                    .put("support_card_type", iv(p, "support_card_type"))
                    .put("is_tips_event", iv(p, "is_tips_event"))
                    .put("partner_type", iv(p, "partner_type"))
                    .put("name", sv(p, "name")))
            }
            o.put("partners", partners)
            val gains = JSONObject()
            val gObj = t.optJSONObject("gains")
            gObj?.keys()?.forEach { k -> gains.put(k, gObj.optLong(k)) }
            o.put("gains", gains)
            trainings.put(o)
        }
        val supportCards = JSONArray()
        val scList = listOf(summary, "support_cards")
        for (i in 0 until scList.length()) {
            val s = scList.optJSONObject(i) ?: continue
            supportCards.put(JSONObject()
                .put("position", iv(s, "position"))
                .put("support_card_id", iv(s, "support_card_id"))
                .put("chara_id", iv(s, "chara_id"))
                .put("kizuna", iv(s, "kizuna"))
                .put("limit_break_count", iv(s, "limit_break_count"))
                .put("rental_type", iv(s, "rental_type")))
        }

        val missing = JSONArray()
        if (festa == null) missing.put("festa")
        if (stats == null) missing.put("stats")
        if (summary.opt("last_action") == null) missing.put("action")
        val notes = JSONArray()
        if (festa != null && !festa.optBoolean("ok", true)) {
            notes.put("festa.ok=false " + festa.optString("error"))
        }
        if (festa != null && acts.length() == 0) notes.put("festa.acts empty")

        return JSONObject()
            .put("seq", frames.size + 1)
            .put("ts_ms", System.currentTimeMillis())
            .put("source", source)
            .put("turn", iv(summary, "turn"))
            .put("raw_total_turn_num", iv(summary, "raw_total_turn_num"))
            .put("year", iv(summary, "year"))
            .put("month", iv(summary, "month"))
            .put("half", iv(summary, "half"))
            .put("turn_semantics", sv(summary, "ui_turn_semantics"))
            .put("scenario", sv(summary, "scenario"))
            .put("chara_id", iv(summary, "chara_id"))
            .put("five", five)
            .put("max_five", maxFive)
            .put("vital", iv(stats, "vital"))
            .put("max_vital", iv(stats, "max_vital"))
            .put("motivation", sv(stats, "motivation"))
            .put("skill_point", iv(stats, "skill_point"))
            .put("fan", iv(stats, "fan"))
            .put("acts", acts)
            .put("advice", advice)
            .put("checkpoints", cps)
            .put("command_info", commandInfo)
            .put("gain_gauges", gainGauges)
            .put("kensan_pending", kensanPending)
            .put("trainings", trainings)
            .put("support_cards", supportCards)
            .put("evaluation_count", evaluationCount)
            .put("evaluation_parsed", false)
            .put("camp_remain_turn", iv(info, "summer_camp_remain_turn"))
            .put("max_act_level", iv(info, "max_act_level"))
            .put("act_training_step", iv(info, "act_training_step"))
            .put("last_action", summary.opt("last_action") ?: JSONObject.NULL)
            .put("notes", notes)
            .put("missing", missing)
            .put("has_festa", festa != null)
            .put("fields_ok", stats != null)
            .put("raw", summary)
    }

    private fun ingest(body: String, source: String) {
        if (body.isBlank()) return
        val raw = try { JSONObject(body) } catch (ignored: Exception) { return }
        // 已是归一化帧（matsuri-capture 格式）就直接用；SO 原始 /summary 才需要映射
        val frame = if (raw.has("five")) raw else normalize(raw, null, source)
        if (source == "push") pushRecv++
        store(frame)
    }

    private fun store(frame: JSONObject) {
        latest = frame
        latestSource = frame.optString("source", "push").ifEmpty { "push" }
        frame.remove("recovered_from_archive") // 新帧不再是归档帧
        lastAt = System.currentTimeMillis()
        synchronized(gate) {
            frames.add(frame)
            while (frames.size > 2000) frames.removeAt(0)
        }
        sessionDir?.let { dir ->
            try {
                FileOutputStream(File(dir, "frames.jsonl"), true).use { f ->
                    val line = frame.toString().replace(Regex("[\\r\\n]+"), " ") + "\n"
                    f.write(line.toByteArray(StandardCharsets.UTF_8))
                }
            } catch (ignored: Exception) {}
        }
    }

    private fun hasFesta(frame: JSONObject?): Boolean {
        if (frame == null) return false
        if (frame.has("has_festa")) return frame.optBoolean("has_festa", false)
        val m = frame.optJSONArray("missing") ?: return false
        for (i in 0 until m.length()) if (m.optString(i) == "festa") return false
        return true
    }

    private fun snapshot(): JSONObject {
        val total = synchronized(gate) { frames.size }
        val f = latest
        val ok = hasFesta(f)
        return JSONObject()
            .put("frames", total)
            .put("latest", f ?: JSONObject.NULL)
            .put("age_ms", if (lastAt == 0L) 0 else System.currentTimeMillis() - lastAt)
            .put("last_at_ms", lastAt)
            .put("service_running", running.get())
            .put("so_alive", soAlive)
            .put("latest_source", latestSource)
            .put("archived_frames", archivedFrames)
            .put("latest_recovered", f?.optBoolean("recovered_from_archive", false) ?: false)
            .put("diff", JSONObject())
            .put("turns", JSONArray())
            .put("has_festa", ok)
            .put("probe_ok", soProbeOk ?: JSONObject.NULL)
            .put("need_so_rebuild", total > 0 && !ok && soProbeOk != true)
            .put("push_recv", pushRecv)
            .put("pull_recv", pullRecv)
            .put("last_pull_ok_ms", lastPullOkAtMs)
            .put("last_summary_error", lastSummaryError)
            .put("stats_ok", f?.optBoolean("fields_ok", false) ?: false)
            .put("source", "18766-kotlin")
    }

    private fun framesJson(path: String): JSONObject {
        val limit = Regex("limit=(\\d+)").find(path)?.groupValues?.get(1)?.toIntOrNull() ?: 100
        val list = synchronized(gate) { frames.toList() }
        val arr = JSONArray()
        list.takeLast(limit).forEach { arr.put(it) }
        return JSONObject().put("frames", arr).put("total", list.size)
    }

    private fun export(): ByteArray {
        val sb = StringBuilder()
        synchronized(gate) {
            frames.forEach { sb.append(it.toString().replace(Regex("[\\r\\n]+"), " ")).append('\n') }
        }
        return sb.toString().toByteArray(StandardCharsets.UTF_8)
    }

    /** 脱敏导出落盘（喂模拟器迭代）：逐帧去掉原始报文 raw、局号重编为匿名序号，
     *  写 NDJSON 到应用外部私有目录（免存储权限，文件管理器 / adb 均可取：
     *  Android/data/com.ranko.matsuricapture/files/exports/）。 */
    private fun exportFile(): JSONObject {
        val r = JSONObject()
        return try {
            val dir = File(appContext!!.getExternalFilesDir(null), "exports").apply { mkdirs() }
            val name = "frames_" + java.text.SimpleDateFormat("yyyyMMdd_HHmmss", java.util.Locale.US)
                .format(java.util.Date()) + ".ndjson"
            val f = File(dir, name)
            var count = 0
            f.bufferedWriter(StandardCharsets.UTF_8).use { w ->
                synchronized(gate) {
                    frames.forEach { fr ->
                        val o = JSONObject(fr.toString())
                        o.remove("raw")        // 原始报文不进导出（脱敏契约）
                        o.put("seq", ++count)  // 局号改匿名序号
                        w.write(o.toString().replace(Regex("[\\r\\n]+"), " "))
                        w.newLine()
                    }
                }
            }
            r.put("ok", true).put("path", f.absolutePath)
                .put("frames", count).put("bytes", f.length())
        } catch (e: Exception) {
            r.put("ok", false).put("error", e.javaClass.simpleName + ": " + (e.message ?: ""))
        }
    }

    /** 与 httpGet 同口径，但返回原始 body 文本（用于逐字节 hash 去重，避免
     *  JSONObject.toString() 键序抖动造成伪「内容变化」）。 */
    private fun httpGetText(route: String): String? {
        return try {
            val c = URL("http://127.0.0.1:18765$route").openConnection() as HttpURLConnection
            c.requestMethod = "GET"
            c.connectTimeout = 1500
            c.readTimeout = 3000
            if (c.responseCode != 200) return null
            c.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
        } catch (ignored: Exception) {
            null
        }
    }

    private fun httpGet(route: String): JSONObject? {
        return try {
            val c = URL("http://127.0.0.1:18765$route").openConnection() as HttpURLConnection
            c.connectTimeout = 1500
            c.readTimeout = 2500
            if (c.responseCode != 200) return null
            val text = c.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
            JSONObject(text)
        } catch (ignored: Exception) {
            null
        }
    }

    /** 主动拉 18765 /summary 合并成一帧（仅前端显式 /api/pull 或自检时触发）。
     *  接线修复：不再在这里打 /debug/festa_probe 重型端点。该探针由 probeLoop
     *  在「首次判活 / SO 重连」时按需探一次并缓存进 soProbeOk 即可；若每次
     *  /api/pull 都探，前端 stale 轮询会把 SO 降频后的全量读又拉回高频。 */
    private fun pull(): JSONObject {
        val health = httpGet("/health")
        soAlive = health != null
        val summary = httpGet("/summary") ?: return JSONObject()
            .put("ok", false).put("error", "18765 /summary unreachable")
            .put("so_alive", soAlive)
            .put("need_so_rebuild", true)
        val action = httpGet("/action/latest")
        if (summary.opt("last_action") == null && action != null) {
            summary.put("last_action", action)
        }
        val frame = normalize(summary, null, "pull")
        store(frame)
        return JSONObject()
            .put("ok", true)
            .put("so_alive", soAlive)
            .put("so_version", health?.optString("version", "") ?: "")
            .put("has_festa", hasFesta(frame))
            .put("probe_ok", soProbeOk ?: JSONObject.NULL)
            .put("need_so_rebuild", !hasFesta(frame) && soProbeOk != true)
            .put("missing", frame.optJSONArray("missing") ?: JSONArray())
    }

    private fun asset(name: String, type: String): Resp {
        val bytes = try {
            appContext!!.assets.open(name).use { it.readBytes() }
        } catch (ignored: Exception) {
            "<html><body><h1>$name missing</h1></body></html>".toByteArray(StandardCharsets.UTF_8)
        }
        return Resp("200 OK", type, bytes)
    }

    private fun html(): Resp = asset("index.html", "text/html; charset=utf-8")

    private fun healthJson(): JSONObject = JSONObject()
        .put("ok", true)
        .put("running", running.get())
        .put("so_alive", soAlive)
        .put("latest_source", latestSource)
        .put("frames", synchronized(gate) { frames.size })
        .put("push_recv", pushRecv)
        .put("pull_recv", pullRecv)
        .put("stats_ok", latest?.optBoolean("fields_ok", false) ?: false)
        .put("bind", "127.0.0.1:18766")

    /**
     * 冷启动恢复：半路退出游戏 / 卡死重进 / App 被回收后，
     * 从 sessions/latest/frames.jsonl 读回上次会话末帧，避免空屏。
     * 恢复帧显式标记 recovered_from_archive=true，前端标注「上次会话」并主动 /api/pull 拉新盘面。
     */
    private fun restoreFromArchive() {
        val dir = sessionDir ?: return
        val f = File(dir, "frames.jsonl")
        if (!f.exists()) return
        try {
            val lines = f.readLines().filter { it.isNotBlank() }
            if (lines.isEmpty()) return
            archivedFrames = lines.size
            val last = JSONObject(lines.last())
            last.put("recovered_from_archive", true)
            last.put("source", "archive")
            latest = last
            latestSource = "archive"
            lastAt = last.optLong("ts_ms", 0L)
            synchronized(gate) {
                frames.clear()
                lines.takeLast(200).forEach { line ->
                    try { frames.add(JSONObject(line)) } catch (ignored: Exception) {}
                }
            }
        } catch (ignored: Exception) {
        }
    }
}
