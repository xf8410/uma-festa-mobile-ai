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
    private var root: LinearLayout? = null
    private var lp: WindowManager.LayoutParams? = null
    private var web: WebView? = null
    private var collapsed = false
    // [APP-FIX-078] 紧凑模式（大屏 / 紧凑 二选一）
    private var compactMode = false
    private var scaleIdx = 0

    override fun onCreate() {
        super.onCreate()
        running = true
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
        if (root == null) addOverlay() else web?.loadUrl(FLOAT_URL)
        return START_STICKY
    }

    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface", "ClickableViewAccessibility")
    private fun addOverlay() {
        if (!canDraw()) {
            stopSelf()
            return
        }
        wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(0xCCEEF3EE.toInt())
        }
        val title = TextView(this).apply {
            text = "祭典杯 AI · 盘面"
            setTextColor(0xFF1B2921.toInt())
            textSize = 13f
            setPadding(dp(10), dp(8), dp(4), dp(8))
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
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
            val w = (0.94 * resources.displayMetrics.widthPixels).toInt()
            // [APP-FIX-077] 初始就给大框高度（约 60% 屏高），不再靠页面回执收成小条
            val bigH = (0.78 * resources.displayMetrics.heightPixels).toInt() // [APP-FIX-079] 一屏
            layoutParams = LinearLayout.LayoutParams(w, bigH)
        }

        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0x00000000)
            addView(header, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            addView(web)
        }
        root = container

        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else
            WindowManager.LayoutParams.TYPE_PHONE

        lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = dp(12)
            y = dp(120)
        }
        wm?.addView(container, lp)
        web?.loadUrl(FLOAT_URL)

        minBtn.setOnClickListener {
            collapsed = !collapsed
            web?.let { w ->
                val wlp = w.layoutParams as LinearLayout.LayoutParams
                if (collapsed) {
                    // 折叠 = 迷你条：页面切到「运气分 ± ｜ 推荐训练」单行，高度压成一条；
                    // 标题栏隐藏，迷你条自身可拖动（见下方 web 触摸逻辑）
                    wlp.height = dp(30)
                    w.layoutParams = wlp
                    header.visibility = View.GONE
                    w.evaluateJavascript("window.setMini&&setMini(true)", null)
                } else {
                    // [APP-FIX-078] 展开：一定回到大屏 + 主面板，杜绝回不去
                    compactMode = false
                    wlp.height = (0.78 * resources.displayMetrics.heightPixels).toInt()
                    w.layoutParams = wlp
                    header.visibility = View.VISIBLE
                    w.loadUrl(FLOAT_URL)
                }
            }
            minBtn.text = if (collapsed) "□" else "—"
            wm?.updateViewLayout(container, lp)
        }
        closeBtn.setOnClickListener { stopSelf() }
        // [APP-FIX-078] ⤢ = 大屏 ⇄ 紧凑，两档互相可逆
        scaleBtn.setOnClickListener {
            compactMode = !compactMode
            web?.let { w ->
                val wlp = w.layoutParams as LinearLayout.LayoutParams
                wlp.width = (0.94 * resources.displayMetrics.widthPixels).toInt()
                if (compactMode) {
                    wlp.height = dp(360)
                    w.layoutParams = wlp
                    w.loadUrl(SMALL_URL)
                } else {
                    wlp.height = (0.78 * resources.displayMetrics.heightPixels).toInt()
                    w.layoutParams = wlp
                    w.loadUrl(FLOAT_URL)
                }
            }
            scaleBtn.text = if (compactMode) "▣" else "⤢"
            wm?.updateViewLayout(container, lp)
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
                    wm?.updateViewLayout(container, lp)
                    true
                }
                else -> false
            }
        }
        // 折叠态（标题栏已隐藏）：迷你条自身可拖动；展开时不拦截 WebView 触摸
        web?.setOnTouchListener { _, ev ->
            if (!collapsed) return@setOnTouchListener false
            // [APP-FIX-078] 迷你条轻点=回到大屏
            if (ev.action == MotionEvent.ACTION_UP) {
                val dx = Math.abs(ev.rawX - tx)
                val dy = Math.abs(ev.rawY - ty)
                if (dx < dp(8) && dy < dp(8)) {
                    collapsed = false
                    compactMode = false
                    minBtn.text = "—"
                    web?.let { w ->
                        val wlp = w.layoutParams as LinearLayout.LayoutParams
                        wlp.height = (0.78 * resources.displayMetrics.heightPixels).toInt()
                        w.layoutParams = wlp
                        w.loadUrl(FLOAT_URL)
                    }
                    header.visibility = View.VISIBLE
                    wm?.updateViewLayout(container, lp)
                    return@setOnTouchListener true
                }
            }
            when (ev.action) {
                MotionEvent.ACTION_DOWN -> {
                    ix = lp!!.x; iy = lp!!.y; tx = ev.rawX; ty = ev.rawY; true
                }
                MotionEvent.ACTION_MOVE -> {
                    lp!!.x = ix + (ev.rawX - tx).toInt()
                    lp!!.y = iy + (ev.rawY - ty).toInt()
                    wm?.updateViewLayout(container, lp)
                    true
                }
                else -> false
            }
        }
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
        root = null; web = null; wm = null; lp = null
        running = false
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
    }

    companion object {
        const val ACTION_SHOW = "com.ranko.matsuricapture.FLOAT_SHOW"
        const val ACTION_STOP = "com.ranko.matsuricapture.FLOAT_STOP"
        private const val CHANNEL = "festa_float"
        private const val NOTIFY_ID = 2
        // [APP-FIX-077] 大面板：加载主面板页
        private const val FLOAT_URL = "http://127.0.0.1:18766/"
        // [APP-FIX-078] 紧凑页
        private const val SMALL_URL = "http://127.0.0.1:18766/float"
        private val SCALES = floatArrayOf(1.0f, 0.70f, 0.45f)
        @Volatile private var running = false
        fun isRunning(): Boolean = running
        private val FOREGROUND_TYPE =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            else 0
    }
}
