package expo.modules.hfosbackup

import android.content.pm.ApplicationInfo
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * On Android the app itself is kept out of backups and device-to-device transfers, by its manifest: backups off, and
 * data extraction rules that leave out every folder (app.config.ts writes both). This creates the folder, and says
 * whether that's in force.
 */
class HfosBackupModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HfosBackup")

    Function("keepOutOfBackups") { path: String ->
      File(path).mkdirs()
      !appBackupAllowed()
    }

    Function("isKeptOutOfBackups") { _: String ->
      !appBackupAllowed()
    }

    Function("appBackupAllowed") {
      appBackupAllowed()
    }
  }

  private fun appBackupAllowed(): Boolean {
    val info = appContext.reactContext?.applicationInfo ?: return true
    return (info.flags and ApplicationInfo.FLAG_ALLOW_BACKUP) != 0
  }
}
