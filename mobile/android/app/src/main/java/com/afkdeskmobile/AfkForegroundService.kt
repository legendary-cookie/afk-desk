package com.afkdeskmobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

class AfkForegroundService : Service() {
  companion object {
    private const val CHANNEL_ID = "afkdesk_connections"
    private const val NOTIFICATION_ID = 7321
  }

  override fun onCreate() {
    super.onCreate()
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(NotificationChannel(
        CHANNEL_ID,
        "AFK connections",
        NotificationManager.IMPORTANCE_LOW
      ).apply { description = "Keeps your selected Minecraft accounts connected" })
    }

    val openApp = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION") Notification.Builder(this)
    }.setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle("AFK Desk is ready")
      .setContentText("On-device Minecraft connections can remain active")
      .setContentIntent(openApp)
      .setOngoing(true)
      .build()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY
  override fun onBind(intent: Intent?): IBinder? = null
}
