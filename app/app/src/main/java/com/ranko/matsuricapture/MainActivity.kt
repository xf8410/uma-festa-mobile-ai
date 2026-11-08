package com.ranko.matsuricapture

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 祭典杯手机版：单页 WebView 壳。
 *
 * 先在本进程拉起 18767 接收端，再从同源 http://127.0.0.1:18767/ 加载面板。
 * 页面所有数值来自 /api/snapshot（真实帧），断线/回前台自动 /api/pull 向 SO 拉当前盘面。
 *
 * 悬浮窗：声明 SYSTEM_ALERT_WINDOW，主动引导到系统的「显示在其他应用上层」设置页，
 * 并把真实授权状态通过 JavascriptInterface 回写给页面（页面不再写死「已允许」）。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            // file:// 兜底时也能访问本机 18767 的 /api/*
            settings.allowUniversalAccessFromFileURLs = true
            setBackgroundColor(0xFFF0F2F5.toInt())
        }
        setContentView(web)
        web.addJavascriptInterface(Bridge(), "Android")

        val dir = File(filesDir, "sessions/latest").apply { mkdirs() }.absolutePath
        if (NativeEngine.start(BIND, dir, this) || portAlreadyServed()) web.loadUrl(LOCAL)
        else retryStart(dir, 0)

        ContextCompat.startForegroundService(this, Intent(this, CaptureService::class.java))
    }

    /** 端口被上一进程占住时，先确认它确实是自己的接收端，是则同源加载，不退回 file:// */
    private fun portAlreadyServed(): Boolean = try {
        val c = URL("$LOCAL/api/health").openConnection() as HttpURLConnection
        c.connectTimeout = 800
        c.readTimeout = 1000
        c.responseCode == 200
    } catch (e: Exception) {
        false
    }

    private fun retryStart(dir: String, attempt: Int) {
        if (attempt >= 5) {
            web.loadUrl(FALLBACK)
            return
        }
        Handler(Looper.getMainLooper()).postDelayed({
            if (NativeEngine.start(BIND, dir, this) || portAlreadyServed()) web.loadUrl(LOCAL)
            else retryStart(dir, attempt + 1)
        }, 600)
    }

    /** 回到前台：把真实授权状态回写页面，并让页面立刻做一次断线重连 */
    override fun onResume() {
        super.onResume()
        pushOverlayState()
        web.evaluateJavascript("if(window.onAppResume) window.onAppResume();", null)
    }

    private fun canDrawOverlays(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this)

    private fun pushOverlayState() {
        val ok = canDrawOverlays()
        val running = FloatingWindowService.isRunning()
        web.evaluateJavascript(
            "if(window.updateOverlayState) window.updateOverlayState($ok,$running);", null
        )
    }

    private fun askOverlayPermission() {
        AlertDialog.Builder(this)
            .setTitle("需要悬浮窗权限")
            .setMessage("要在游戏上方显示实时盘面，请开启「显示在其他应用上层」。\n开启后返回本 App，点「开启游戏内悬浮窗」即可。")
            .setPositiveButton("去开启") { _, _ ->
                val i = Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:$packageName")
                )
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(i)
            }
            .setNegativeButton("稍后", null)
            .show()
    }

    private fun startFloating(): Boolean {
        if (!canDrawOverlays()) return false
        ContextCompat.startForegroundService(
            this, Intent(this, FloatingWindowService::class.java).setAction(FloatingWindowService.ACTION_SHOW)
        )
        return true
    }

    private fun stopFloating(): Boolean {
        stopService(Intent(this, FloatingWindowService::class.java))
        return true
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    /** 供页面调用的真实能力；方法运行在 WebView 线程，UI 操作回主线程 */
    inner class Bridge {
        @JavascriptInterface
        fun canDrawOverlays(): Boolean = this@MainActivity.canDrawOverlays()

        @JavascriptInterface
        fun isFloating(): Boolean = FloatingWindowService.isRunning()

        @JavascriptInterface
        fun requestOverlayPermission() = runOnUiThread { askOverlayPermission() }

        @JavascriptInterface
        fun startFloating(): Boolean = this@MainActivity.startFloating()

        @JavascriptInterface
        fun stopFloating(): Boolean = this@MainActivity.stopFloating()

        @JavascriptInterface
        fun refreshOverlayState() = runOnUiThread { pushOverlayState() }

        @JavascriptInterface
        fun toast(msg: String?) = runOnUiThread {
            android.widget.Toast.makeText(this@MainActivity, msg ?: "", android.widget.Toast.LENGTH_SHORT).show()
        }
    }

    companion object {
        const val BIND = "127.0.0.1:18767"
        const val LOCAL = "http://127.0.0.1:18767/"
        const val FALLBACK = "file:///android_asset/index.html"
    }
}
