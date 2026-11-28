package expo.modules.hfosshared

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The preferences file the app keeps for the parts of HandsFreeOS that run outside its screens. The keyboard
 * (modules/hfos-keyboard) reads the same file by this name; the app's backup rules (app.config.ts) leave every
 * preferences file out of backups and phone-to-phone transfers.
 */
const val SHARED_PREFERENCES = "hfos_shared"

private val KEY = Regex("^[a-z0-9-]{1,40}$")

/**
 * What the app keeps for its keyboard and widgets: one JSON string per key ("keyboard", "widgets"). On Android the
 * keyboard is part of the app, so a private preferences file is all it takes.
 */
class HfosSharedModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HfosShared")

    /** Saves the JSON under the key, or removes it with null. False when it couldn't be saved. */
    Function("write") { key: String, json: String? ->
      val context = appContext.reactContext ?: return@Function false
      if (!KEY.matches(key)) return@Function false
      val prefs = context.getSharedPreferences(SHARED_PREFERENCES, Context.MODE_PRIVATE).edit()
      if (json == null) prefs.remove(key) else prefs.putString(key, json)
      prefs.commit()
    }

    /** What's saved under the key, or null. */
    Function("read") { key: String ->
      val context = appContext.reactContext ?: return@Function null
      if (!KEY.matches(key)) return@Function null
      context.getSharedPreferences(SHARED_PREFERENCES, Context.MODE_PRIVATE).getString(key, null)
    }
  }
}
