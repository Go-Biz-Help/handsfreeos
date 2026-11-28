package expo.modules.hfoskeyboard

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.view.inputmethod.InputMethodManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * What the app's Settings → Phone keyboard screen asks Android: whether the HandsFreeOS keyboard is switched on and in
 * use, the phone's keyboard settings to switch it on, and the phone's keyboard picker.
 */
class HfosKeyboardModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HfosKeyboard")

    Function("state") {
      val context = appContext.reactContext
        ?: return@Function mapOf("enabled" to false, "current" to false)
      mapOf("enabled" to isEnabled(context), "current" to isCurrent(context))
    }

    Function("openSettings") {
      val context = appContext.reactContext ?: return@Function false
      try {
        context.startActivity(
          Intent(Settings.ACTION_INPUT_METHOD_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        true
      } catch (e: Exception) {
        false
      }
    }

    Function("showPicker") {
      val context = appContext.reactContext ?: return@Function false
      val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        ?: return@Function false
      imm.showInputMethodPicker()
      true
    }
  }

  private fun isOurs(context: Context, component: ComponentName?): Boolean =
    component != null &&
      component.packageName == context.packageName &&
      component.className == HfosKeyboardService::class.java.name

  private fun isEnabled(context: Context): Boolean {
    val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager ?: return false
    return imm.enabledInputMethodList.any { isOurs(context, it.component) }
  }

  private fun isCurrent(context: Context): Boolean {
    val current = Settings.Secure.getString(context.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)
      ?: return false
    return isOurs(context, ComponentName.unflattenFromString(current))
  }
}
