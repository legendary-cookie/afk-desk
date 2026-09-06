package com.afkdeskmobile

import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class AfkForegroundServiceModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName(): String = "AfkForegroundService"

  @ReactMethod
  fun setSessionCount(count: Double, promise: Promise) {
    if (!count.isFinite() || count < 0 || count > Int.MAX_VALUE || count % 1.0 != 0.0) {
      promise.reject("INVALID_SESSION_COUNT", "Session count must be a nonnegative integer.")
      return
    }
    reactApplicationContext.runOnUiQueueThread {
      try {
        val intent = Intent(reactApplicationContext, AfkForegroundService::class.java)
          .putExtra(AfkForegroundService.SESSION_COUNT, count.toInt())
        if (count == 0.0) {
          reactApplicationContext.stopService(intent)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          reactApplicationContext.startForegroundService(intent)
        } else {
          reactApplicationContext.startService(intent)
        }
        promise.resolve(null)
      } catch (error: Exception) {
        promise.reject("FOREGROUND_SERVICE_FAILED", "Android could not update background connection protection: ${error.message}", error)
      }
    }
  }
}
