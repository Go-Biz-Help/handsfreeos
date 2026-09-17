package expo.modules.hfosphone

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.ContactsContract
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * What the app asks the phone itself:
 * - whether it's locked, before a notification button that reaches a customer or approves something runs (Expo's
 *   Android code ignores a button's "authentication required", so the app checks the keyguard itself);
 * - to open a page on the web in the browser. The app claims app.handsfreeos.com/app/… links, so opening one of those
 *   with a plain VIEW intent would come straight back to the app; this names the browser.
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
