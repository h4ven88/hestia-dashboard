package com.hestari.hestia

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Receives push for the app. The dashboard's Web Push path cannot run here at
 * all: an Android WebView has no Push API and no service worker push, so FCM
 * is the only way to reach a device whose screen is off.
 *
 * MESSAGES ARE EXPECTED DATA-ONLY, and that is a requirement rather than a
 * preference. A message carrying a `notification` block is rendered by the
 * system whenever the app is backgrounded, which means this class never runs
 * and the app cannot choose the channel, the importance or the tap target. A
 * door chime and a smoke alarm would land identically. Data-only keeps the
 * decision here.
 *
 * The backend therefore sends: title, body, category, and optionally tag.
 */
class HestiaMessaging : FirebaseMessagingService() {

    override fun onMessageReceived(message: RemoteMessage) {
        val d = message.data
        val category = d["category"].orEmpty()
        val title = d["title"] ?: "Hestia"
        val body = d["body"].orEmpty()

        /* A tag collapses repeats of the same thing. Without one, a sensor
           flapping produces a column of identical notifications; with one, the
           latest replaces the previous. Falls back to the category so at worst
           repeats collapse per kind rather than not at all. */
        val tag = d["tag"] ?: category.ifEmpty { "hestia" }

        notify(this, category, title, body, tag)
    }

    /**
     * A new token invalidates whatever the backend has for this device.
     *
     * It is only STORED here, not uploaded. Registration is authorised against
     * the household record, and the credentials for that live in the page, not
     * in the native layer. The page re-registers on boot already, so the next
     * launch carries the new token up. The cost of that choice is a window
     * where push is sent to a dead token, which the backend already handles by
     * pruning what the transport rejects.
     */
    override fun onNewToken(token: String) {
        storeToken(this, token)
        android.util.Log.i(TAG, "FCM token refreshed; the page will re-register on next launch")
    }

    companion object {
        private const val TAG = "HestiaPush"
        private const val PREFS = "hestia_push"
        private const val KEY_TOKEN = "fcm_token"

        /* Two channels, split by what the user would want to treat
           differently at 3am. Android lets each be silenced independently, and
           a single channel would force "all or nothing" on a security
           product. Categories that bypass the armed gate in pushDispatch.js
           are the same ones that belong in the urgent channel. */
        const val CH_ALERTS = "hestia_alerts"
        const val CH_EVENTS = "hestia_events"
        private val URGENT = setOf("smoke", "water", "alarm", "intrusion")

        fun storeToken(ctx: Context, token: String) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(KEY_TOKEN, token).apply()
        }

        fun storedToken(ctx: Context): String? =
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_TOKEN, null)

        fun ensureChannels(ctx: Context) {
            val mgr = ctx.getSystemService(NotificationManager::class.java) ?: return
            mgr.createNotificationChannel(NotificationChannel(
                CH_ALERTS, "Security alerts", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Smoke, water and the alarm sounding"
            })
            mgr.createNotificationChannel(NotificationChannel(
                CH_EVENTS, "Home events", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Doors, windows, locks, motion, arming and reminders"
            })
        }

        fun notify(ctx: Context, category: String, title: String, body: String, tag: String) {
            ensureChannels(ctx)
            val channel = if (category in URGENT) CH_ALERTS else CH_EVENTS

            val open = PendingIntent.getActivity(
                ctx, 0,
                Intent(ctx, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

            val n = NotificationCompat.Builder(ctx, channel)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(body)
                // Long bodies are truncated to one line without this, and a
                // door-left-open message loses the part that says which door.
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(open)
                .setCategory(if (channel == CH_ALERTS) NotificationCompat.CATEGORY_ALARM
                             else NotificationCompat.CATEGORY_STATUS)
                .setPriority(if (channel == CH_ALERTS) NotificationCompat.PRIORITY_HIGH
                             else NotificationCompat.PRIORITY_DEFAULT)
                .build()

            /* POST_NOTIFICATIONS may have been revoked since registration, and
               notify() throws rather than returning a failure when it has. */
            runCatching { NotificationManagerCompat.from(ctx).notify(tag, 1, n) }
                .onFailure { android.util.Log.w(TAG, "could not post notification: ${it.message}") }
        }
    }
}
