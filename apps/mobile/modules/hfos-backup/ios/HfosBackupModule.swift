import ExpoModulesCore

/// Keeps a folder, and everything that is ever put in it, out of iCloud and computer backups. The phone's encrypted
/// copy of each business and the photos waiting to upload live in one such folder: SQLite replaces its `-wal` and
/// `-shm` files as it goes, and a mark on the folder covers them all, where a mark on each file would be lost.
public class HfosBackupModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HfosBackup")

    /// Creates the folder if it isn't there, marks it, and says whether the mark is now set.
    Function("keepOutOfBackups") { (path: String) throws -> Bool in
      var url = URL(fileURLWithPath: path, isDirectory: true)
      try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try url.setResourceValues(values)
      return HfosBackupModule.isExcluded(url)
    }

    /// Whether backups leave this file or folder out.
    Function("isKeptOutOfBackups") { (path: String) -> Bool in
      return HfosBackupModule.isExcluded(URL(fileURLWithPath: path))
    }

    /// iOS backs up app files unless a folder is marked; Android's switch is the app's own (see Android).
    Function("appBackupAllowed") { () -> Bool in
      return true
    }
  }

  private static func isExcluded(_ url: URL) -> Bool {
    let values = try? url.resourceValues(forKeys: [.isExcludedFromBackupKey])
    return values?.isExcludedFromBackup ?? false
  }
}
