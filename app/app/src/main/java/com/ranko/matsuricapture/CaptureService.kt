package com.ranko.matsuricapture

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import java.io.File

/**
 * 前台服务：让接收端在你切回游戏训练时不被系统杀掉。
 *
 * 没这个的话 App 进后台随时会被回收，而 SO 的 push_loop 连不上就静默跳过，
 * 丢掉的帧不会补推 —— 数据就断了。
 * 通知常驻，类型 dataSync（Android 14 起必须给类型）。
 */
class CaptureService : Service() {

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val dir = File(filesDir, "sessions/latest").apply { mkdirs() }.absolutePath
        NativeEngine.start(MainActivity.BIND, dir, this)
        startShowing()
        return START_STICKY
    }

    private fun startShowing() {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "祭典杯 AI · 接收", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val n: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("祭典杯 AI · 接收")
            .setContentText("监听 ${MainActivity.BIND}，收 SO 推送的数据")
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .build()
        ServiceCompat.startForeground(this, NOTIFY_ID, n, FOREGROUND_TYPE)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL = "capture"
        private const val NOTIFY_ID = 1
        private val FOREGROUND_TYPE =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            else 0
    }
}
