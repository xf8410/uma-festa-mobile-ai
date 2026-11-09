package com.ranko.matsuricapture

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import java.io.File

/**
 * 真正的 Android 系统级悬浮窗（TYPE_APPLICATION_OVERLAY）。
 *
 * 由前台服务持有，App 退到后台 / 游戏在前台时仍可盖在游戏上方。
 * 内容是一个同源 WebView，轮询 18766 的 /api/snapshot 显示实时盘面；
 * 断线重连逻辑与主页一致（NativeEngine 的 /api/pull 会主动向 SO 拉当前帧）。
 */
class FloatingWindowService : Service() {

    private var wm: WindowManager? = null
    private var root: android.widget.FrameLayout? = null
    private var lp: WindowManager.LayoutParams? = null
    private var web: WebView? = null
    private var headerBar: LinearLayout? = null
    private var gripView: View? = null
    private var collapsed = false
    private var scaleIdx = 0
    // [APP-FIX-106] 右下角拖拽把手的起点
    private var resStartW = 0
    private var resStartH = 0
    private var resStartX = 0f
    private var resStartY = 0f
    // [APP-FIX-106] 迷你条点按恢复（与拖动区分）
    private var tapX = 0f
    private var tapY = 0f
    private var tapAt = 0L

    /** 浮窗透明度（30–100，默认 80；页面与标题栏共用） */
    private fun opacityPct(): Int =
        getSharedPreferences(PREFS, MODE_PRIVATE).getInt(KEY_OPACITY, 80).coerceIn(30, 100)

    override fun onCreate() {
        super.onCreate()
        running = true
        instance = this
        // 确保接收端在跑（冷启动只开了浮窗服务时也能拿到数据）
        val dir = File(filesDir, "sessions/latest").apply { mkdirs() }.absolutePath
        NativeEngine.start(MainActivity.BIND, dir, this)
        startShowing()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (root == null) addOverlay() else web?.loadUrl(floatUrlOf())
        return START_STICKY
    }

    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface", "ClickableViewAccessibility")
    private fun addOverlay() {
        if (!canDraw()) {
            stopSelf()
            return
        }
        wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val op = opacityPct()

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(headerColor(op))
        }
        headerBar = header
        val title = TextView(this).apply {
            text = "祭典杯 AI · 盘面"
            setTextColor(0xFF1B2921.toInt())
            textSize = 13f
            setPadding(dp(10), dp(8), dp(4), dp(8))
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        // [APP-CFG-3294] 齿轮：页内设置面板（引擎线程/局数 + 透明度）
        val gearBtn = Button(this).apply {
            text = "⚙"; textSize = 12f
            setBackgroundColor(0x00000000); setTextColor(0xFF1B2921.toInt())
        }
        val scaleBtn = Button(this).apply {
            text = "⤢"; textSize = 12f
            setBackgroundColor(0x00000000); setTextColor(0xFF1B2921.toInt())
        }
        val minBtn = Button(this).apply {
            text = "—"; textSize = 12f
            setBackgroundColor(0x00000000); setTextColor(0xFF1B2921.toInt())
        }
        val closeBtn = Button(this).apply {
            text = "✕"; textSize = 12f
            setBackgroundColor(0x00000000); setTextColor(0xFF1B2921.toInt())
        }
        header.addView(title)
        header.addView(gearBtn, LinearLayout.LayoutParams(dp(40), LinearLayout.LayoutParams.WRAP_CONTENT))
        header.addView(scaleBtn, LinearLayout.LayoutParams(dp(40), LinearLayout.LayoutParams.WRAP_CONTENT))
        header.addView(minBtn, LinearLayout.LayoutParams(dp(44), LinearLayout.LayoutParams.WRAP_CONTENT))
        header.addView(closeBtn, LinearLayout.LayoutParams(dp(44), LinearLayout.LayoutParams.WRAP_CONTENT))

        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowUniversalAccessFromFileURLs = true
            setBackgroundColor(0x00000000)
            addJavascriptInterface(FloatBridge(), "Android")
            // 紧凑一屏面板：宽约屏宽 94%，高度由页面 reportHeight 回执收紧（WebView
            // 的 WRAP_CONTENT 不按内容收缩）。折叠时高度压成迷你条。
            // [APP-FIX-094] 撑满窗口，窗口尺寸由外面的拖拽条决定
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f
            )
        }

        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0x00000000)
            addView(header, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            addView(web)
        }
        // [APP-FIX-106] 去掉底部「⇳ 拖拽缩放」四字条，改正常缩放：
        // 右下角一个半透明三角把手，按住拖 = 自由改窗口宽高（松手即停，无极档）。
        val frame = android.widget.FrameLayout(this)
        frame.addView(container)
        val grip = TextView(this).apply {
            text = "◢"
            textSize = 13f
            gravity = Gravity.BOTTOM or Gravity.END
            setTextColor(0x66000000)
            setPadding(0, 0, dp(6), dp(3))
        }
        frame.addView(grip, android.widget.FrameLayout.LayoutParams(dp(30), dp(26), Gravity.BOTTOM or Gravity.END))
        gripView = grip
        grip.setOnTouchListener { _, ev ->
            val params = lp ?: return@setOnTouchListener false
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    resStartW = params.width
                    resStartH = params.height
                    resStartX = ev.rawX
                    resStartY = ev.rawY
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val mw = resources.displayMetrics.widthPixels
                    val mh = (0.95 * resources.displayMetrics.heightPixels).toInt()
                    params.width = (resStartW + (ev.rawX - resStartX)).toInt().coerceIn(dp(140).coerceAtMost(mw), mw)
                    params.height = (resStartH + (ev.rawY - resStartY)).toInt().coerceIn(dp(90).coerceAtMost(mh), mh)
                    try { wm?.updateViewLayout(frame, params) } catch (e: Throwable) { }
                    true
                }
                else -> false
            }
        }
        root = frame

        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else
            WindowManager.LayoutParams.TYPE_PHONE

        val initW = (0.94 * resources.displayMetrics.widthPixels).toInt()
        val initH = (0.42 * resources.displayMetrics.heightPixels).toInt()
        lp = WindowManager.LayoutParams(
            initW,
            initH,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = dp(12)
            y = dp(120)
        }
        wm?.addView(frame, lp)
        web?.loadUrl(floatUrlOf())

        minBtn.setOnClickListener { setCollapsed(!collapsed, minBtn) }
        closeBtn.setOnClickListener { stopSelf() }
        // [APP-CFG-3294] 齿轮 → 页内设置面板开关
        gearBtn.setOnClickListener {
            web?.evaluateJavascript("window.toggleSettings&&toggleSettings()", null)
        }
        // 缩放：100% → 70% → 45% 循环，页面整体 zoom，窗口宽度同步缩（露出游戏画面）
        scaleBtn.setOnClickListener {
            scaleIdx = (scaleIdx + 1) % SCALES.size
            val sc = SCALES[scaleIdx]
            web?.let { w ->
                val wlp = w.layoutParams as LinearLayout.LayoutParams
                wlp.width = ((0.94 * resources.displayMetrics.widthPixels) * sc).toInt()
                w.layoutParams = wlp
                w.evaluateJavascript("window.setZoom&&setZoom($sc)", null)
            }
            scaleBtn.text = if (sc >= 1f) "⤢" else "${(sc * 100).toInt()}"
            wm?.updateViewLayout(frame, lp)
        }

        var ix = 0; var iy = 0; var tx = 0f; var ty = 0f
        header.setOnTouchListener { _, ev ->
            when (ev.action) {
                MotionEvent.ACTION_DOWN -> {
                    ix = lp!!.x; iy = lp!!.y; tx = ev.rawX; ty = ev.rawY; true
                }
                MotionEvent.ACTION_MOVE -> {
                    lp!!.x = ix + (ev.rawX - tx).toInt()
                    lp!!.y = iy + (ev.rawY - ty).toInt()
                    wm?.updateViewLayout(frame, lp)
                    true
                }
                else -> false
            }
        }
        // [APP-FIX-106] 折叠态：迷你条可拖动；轻点（位移小+时间短）= 恢复全盘面。
        // 之前折叠后标题栏隐藏、没有任何恢复入口，只能关掉重开。
        web?.setOnTouchListener { _, ev ->
            if (!collapsed) return@setOnTouchListener false
            when (ev.action) {
                MotionEvent.ACTION_DOWN -> {
                    ix = lp!!.x; iy = lp!!.y; tx = ev.rawX; ty = ev.rawY
                    tapX = ev.rawX; tapY = ev.rawY; tapAt = ev.eventTime
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    lp!!.x = ix + (ev.rawX - tx).toInt()
                    lp!!.y = iy + (ev.rawY - ty).toInt()
                    wm?.updateViewLayout(frame, lp)
                    true
                }
                MotionEvent.ACTION_UP -> {
                    val moved = kotlin.math.abs(ev.rawX - tapX) + kotlin.math.abs(ev.rawY - tapY)
                    if (moved < dp(12) && ev.eventTime - tapAt < 400) setCollapsed(false, null)
                    true
                }
                else -> false
            }
        }
    }

    /** 折叠/展开统一入口（minBtn 可能为空：迷你条点按恢复时传 null） */
    private fun setCollapsed(c: Boolean, minBtn: Button?) {
        if (collapsed == c) return
        collapsed = c
        val w = web ?: return
        val hdr = headerBar ?: return
        val cont = root ?: return
        if (c) {
            lp?.height = dp(34) // 折叠 = 迷你条窗口高度
            hdr.visibility = View.GONE
            gripView?.visibility = View.GONE // 迷你条态藏缩放把手，别挡点按恢复
            w.evaluateJavascript("window.setMini&&setMini(true)", null)
        } else {
            lp?.height = (0.42 * resources.displayMetrics.heightPixels).toInt()
            hdr.visibility = View.VISIBLE
            gripView?.visibility = View.VISIBLE
            w.evaluateJavascript("window.setMini&&setMini(false)", null)
        }
        minBtn?.text = if (c) "□" else "—"
        // 点按恢复时 minBtn 为 null，直接从标题栏找按钮更新文案
        if (minBtn == null) {
            for (i in 0 until hdr.childCount) {
                val b = hdr.getChildAt(i)
                if (b is Button && (b.text == "□" || b.text == "—")) b.text = if (c) "□" else "—"
            }
        }
        try { wm?.updateViewLayout(cont, lp) } catch (e: Throwable) { }
    }

    private fun headerColor(opPct: Int): Int {
        val a = (0xCC * opPct / 100).coerceIn(0, 255)
        return (a shl 24) or 0xEEF3EE
    }

    private fun canDraw(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this)

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun startShowing() {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "祭典杯 AI · 悬浮窗", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val n: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("祭典杯 AI · 悬浮窗")
            .setContentText("显示实时盘面，可拖动标题栏")
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .build()
        ServiceCompat.startForeground(this, NOTIFY_ID, n, FOREGROUND_TYPE)
    }

    override fun onDestroy() {
        try { root?.let { wm?.removeView(it) } } catch (ignored: Exception) {}
        web?.destroy()
        root = null; web = null; wm = null; lp = null; headerBar = null; gripView = null
        running = false
        instance = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    inner class FloatBridge {
        @JavascriptInterface
        fun close() = Handler(Looper.getMainLooper()).post { stopSelf() }

        /** 页面 render 后回执内容高度（CSS px）：WebView 的 WRAP_CONTENT 不按内容收缩，
         *  由这里把浮窗高度收紧到内容实际高度，消除底部大段空白。 */
        @JavascriptInterface
        fun reportHeight(cssPx: Int) = Handler(Looper.getMainLooper()).post {
            if (collapsed) return@post
            val w = web ?: return@post
            val c = root ?: return@post
            val wlp = w.layoutParams as? LinearLayout.LayoutParams ?: return@post
            val maxH = (0.82 * resources.displayMetrics.heightPixels).toInt()
            val h = (cssPx * resources.displayMetrics.density).toInt().coerceIn(dp(120), maxH)
            if (wlp.height != h) {
                wlp.height = h
                w.layoutParams = wlp
                wm?.updateViewLayout(c, lp)
            }
        }

        // ── [APP-FIX-106] 透明度（30–100）────────────────────────────
        @JavascriptInterface
        fun getOpacity(): Int = opacityPct()

        @JavascriptInterface
        fun setOpacity(pct: Int) {
            val v = pct.coerceIn(30, 100)
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putInt(KEY_OPACITY, v).apply()
            Handler(Looper.getMainLooper()).post {
                headerBar?.setBackgroundColor(headerColor(v))
                web?.evaluateJavascript("window.setPageOpacity&&setPageOpacity($v)", null)
            }
        }

        // ── [APP-CFG-3294] 引擎参数：线程数 / 搜索局数 ────────────────
        @JavascriptInterface
        fun getEngineCfg(): String =
            EngineBridge.getThreads(this@FloatingWindowService).toString() + "," +
                EngineBridge.getSearchN(this@FloatingWindowService)

        /** 保存线程/局数并重启引擎（新进程才吃新参数）；返回实际生效值 "t,n" */
        @JavascriptInterface
        fun setEngineCfg(threads: Int, searchN: Int): String {
            EngineBridge.applyConfig(this@FloatingWindowService, threads, searchN)
            return EngineBridge.getThreads(this@FloatingWindowService).toString() + "," +
                EngineBridge.getSearchN(this@FloatingWindowService)
        }

        @JavascriptInterface
        fun engineStatus(): String = EngineBridge.statusJson()
    }

    companion object {
        const val ACTION_SHOW = "com.ranko.matsuricapture.FLOAT_SHOW"
        const val ACTION_STOP = "com.ranko.matsuricapture.FLOAT_STOP"
        private const val PREFS = "float_cfg"
        private const val KEY_OPACITY = "opacity_pct"
        private const val CHANNEL = "festa_float"
        private const val NOTIFY_ID = 2
        private const val FLOAT_URL = "http://127.0.0.1:18766/float"
        // [APP-FIX-084] 实际绑定端口（18766 被占时是 18764）
        private fun floatUrlOf(): String {
            val p = NativeEngine.boundPort
            return "http://127.0.0.1:" + (if (p > 0) p else 18766) + "/float"
        }
        private val SCALES = floatArrayOf(1.0f, 0.70f, 0.45f)
        @Volatile private var running = false
        @Volatile private var instance: FloatingWindowService? = null
        fun isRunning(): Boolean = running
        // [APP-CFG-3295] 主页面改透明度时，浮窗在跑则即时刷新标题栏+页面
        fun refreshOpacity() {
            val s = instance ?: return
            Handler(Looper.getMainLooper()).post {
                val op = s.opacityPct()
                s.headerBar?.setBackgroundColor(s.headerColor(op))
                s.web?.evaluateJavascript("window.setPageOpacity&&setPageOpacity($op)", null)
            }
        }
        private val FOREGROUND_TYPE =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            else 0
    }
}
