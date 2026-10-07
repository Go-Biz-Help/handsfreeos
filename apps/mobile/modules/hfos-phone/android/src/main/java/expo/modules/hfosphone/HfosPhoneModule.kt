package expo.modules.hfosphone

import android.app.Activity
import android.app.KeyguardManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.ContactsContract
import android.provider.ContactsContract.CommonDataKinds.Phone
import androidx.core.content.FileProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import java.io.File
import expo.modules.kotlin.modules.ModuleDefinition

/** The request the contacts app's picker answers. */
private const val PICK_CONTACT = 7311

/**
 * What the app asks the phone itself:
 * - whether it's locked, before a notification button that reaches a customer or approves something runs (Expo's
 *   Android code ignores a button's "authentication required", so the app checks the keyguard itself);
 * - to open a page on the web in the browser. The app claims app.handsfreeos.com/app/… links, so opening one of those
 *   with a plain VIEW intent would come straight back to the app; this names the browser;
 * - to show a document the phone keeps, decrypted into the app's cache for the moment, in the phone's viewer;
 * - to let the person pick one of their contacts' numbers in the contacts app's own picker.
 */
class HfosPhoneModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HfosPhone")

    /** The phone is locked with its PIN, pattern, password or a fingerprint (not a swipe). */
    Function("isDeviceLocked") {
      val context = appContext.reactContext ?: return@Function false
      val keyguard = context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
      keyguard?.isDeviceLocked ?: false
    }

    /** Opens the address in the phone's browser, never in HandsFreeOS itself; false when there's no browser. */
    AsyncFunction("openInBrowser") { url: String ->
      val context = appContext.reactContext ?: return@AsyncFunction false
      val browser = browserPackage(context) ?: return@AsyncFunction false
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        .addCategory(Intent.CATEGORY_BROWSABLE)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        .setPackage(browser)
      try {
        context.startActivity(intent)
        true
      } catch (e: Exception) {
        false
      }
    }

    /**
     * Shows a file the app decrypted into its cache (a document kept on the phone) in the phone's viewer for its type,
     * read-only, through expo-sharing's file provider. "opened", or "unavailable" with no app for it. Android doesn't
     * say when the viewer closes: the app deletes the copy when it's back in front.
     */
    AsyncFunction("viewFile") { path: String, mimeType: String ->
      val activity = appContext.currentActivity ?: return@AsyncFunction "unavailable"
      val file = File(Uri.parse(path).path ?: path)
      if (!file.exists()) return@AsyncFunction "unavailable"
      val uri = FileProvider.getUriForFile(
        activity,
        activity.applicationInfo.packageName + ".SharingFileProvider",
        file,
      )
      val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, mimeType)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      try {
        activity.startActivity(intent)
        "opened"
      } catch (e: ActivityNotFoundException) {
        "unavailable"
      }
    }

    /**
     * Lets the person pick one of their contacts' numbers in the contacts app's own picker, which hands HandsFreeOS
     * that one number and the contact's name and nothing else, so the app needs no contacts permission. The name and
     * number; "cancelled"; or "unavailable" with no contacts app.
     */
    AsyncFunction("pickContact") { promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.resolve("unavailable")
        return@AsyncFunction
      }
      if (picking != null) {
        promise.resolve("cancelled")
        return@AsyncFunction
      }
      val intent = Intent(Intent.ACTION_PICK).setType(Phone.CONTENT_TYPE)
      try {
        picking = promise
        activity.startActivityForResult(intent, PICK_CONTACT)
      } catch (e: ActivityNotFoundException) {
        picking = null
        promise.resolve("unavailable")
      }
    }

    OnActivityResult { activity, payload ->
      if (payload.requestCode != PICK_CONTACT) return@OnActivityResult
      val promise = picking ?: return@OnActivityResult
      picking = null
      val row = payload.data?.data
      if (payload.resultCode != Activity.RESULT_OK || row == null) {
        promise.resolve("cancelled")
        return@OnActivityResult
      }
      promise.resolve(pickedNumber(activity, row) ?: "cancelled")
    }

    /**
     * Opens the contacts app's New Contact screen with the business's name and number filled in; the contacts app
     * saves it, so HandsFreeOS needs no contacts permission. "opened", or "unavailable" with no contacts app. Android
     * doesn't say whether it was saved.
     */
    AsyncFunction("addContact") { name: String, phone: String ->
      val activity = appContext.currentActivity ?: return@AsyncFunction "unavailable"
      val intent = Intent(Intent.ACTION_INSERT).apply {
        type = ContactsContract.Contacts.CONTENT_TYPE
        // The business's name as the company only: as a person's name, Contacts splits it into first, middle and last.
        putExtra(ContactsContract.Intents.Insert.COMPANY, name)
        putExtra(ContactsContract.Intents.Insert.PHONE, phone)
        putExtra(
          ContactsContract.Intents.Insert.PHONE_TYPE,
          ContactsContract.CommonDataKinds.Phone.TYPE_WORK,
        )
        putExtra("finishActivityOnSaveCompleted", true)
      }
      try {
        activity.startActivity(intent)
        "opened"
      } catch (e: Exception) {
        "unavailable"
      }
    }
  }

  /** The contact picker's answer, waited on while it's open. */
  private var picking: Promise? = null

  /**
   * The name and the one number picked, read through the grant the contacts app gives for that one row; null when
   * the row can't be read.
   */
  private fun pickedNumber(context: Context, row: Uri): Map<String, Any?>? {
    val columns = arrayOf(Phone.DISPLAY_NAME, Phone.NUMBER, Phone.NORMALIZED_NUMBER, Phone.TYPE, Phone.LABEL)
    return try {
      context.contentResolver.query(row, columns, null, null, null)?.use { cursor ->
        if (!cursor.moveToFirst()) return@use null
        val type = cursor.getInt(3)
        val custom = cursor.getString(4)
        val label = if (type == Phone.TYPE_CUSTOM) {
          custom ?: ""
        } else {
          Phone.getTypeLabel(context.resources, type, custom).toString()
        }
        mapOf(
          "name" to (cursor.getString(0) ?: ""),
          "phones" to listOf(
            mapOf("number" to (cursor.getString(1) ?: ""), "e164" to cursor.getString(2), "label" to label),
          ),
        )
      }
    } catch (e: SecurityException) {
      null
    }
  }

  /** The browser that opens a web address no app claims: the phone's default, else the first one it has. */
  private fun browserPackage(context: Context): String? {
    val probe = Intent(Intent.ACTION_VIEW, Uri.parse("https://www.example.com/"))
      .addCategory(Intent.CATEGORY_BROWSABLE)
    val pm = context.packageManager
    val own = context.packageName
    val browsers = pm.queryIntentActivities(probe, 0)
      .map { it.activityInfo.packageName }
      .filter { it != own }
    val preferred = pm.resolveActivity(probe, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName
    return preferred?.takeIf { browsers.contains(it) } ?: browsers.firstOrNull()
  }
}
