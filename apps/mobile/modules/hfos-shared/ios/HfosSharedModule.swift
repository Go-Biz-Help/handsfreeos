import ExpoModulesCore
import Foundation

/// The App Group the app shares with its keyboard and widgets (app.json `ios.entitlements`). The keyboard target says
/// the same in `targets/keyboard/SharedStore.swift`; test builds share the store app's ids, so one name serves both.
let hfosAppGroup = "group.com.gobizhelp.handsfreeos"

/// What the app keeps for the parts of HandsFreeOS that run outside it: one JSON file per key in the App Group, in a
/// folder kept out of iCloud and computer backups. The folder's mark covers every file ever written into it, and an
/// atomic write replaces a file whole, so the keyboard never reads half of one.
public class HfosSharedModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HfosShared")

    /// Saves the JSON under the key, or removes it with nil. False when the App Group isn't there or the write failed.
    Function("write") { (key: String, json: String?) -> Bool in
      guard let file = HfosSharedModule.file(for: key) else { return false }
      guard let json = json else {
        try? FileManager.default.removeItem(at: file)
        return true
      }
      do {
        try Data(json.utf8).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return true
      } catch {
        return false
      }
    }

    /// What's saved under the key, or nil.
    Function("read") { (key: String) -> String? in
      guard let file = HfosSharedModule.file(for: key), let data = try? Data(contentsOf: file) else { return nil }
      return String(data: data, encoding: .utf8)
    }
  }

  /// A key is a short lowercase name ("keyboard", "keyboard-seen", "widgets"), so it can't reach outside the folder.
  static func file(for key: String) -> URL? {
    guard key.range(of: "^[a-z0-9-]{1,40}$", options: .regularExpression) != nil else { return nil }
    guard let folder = folder() else { return nil }
    return folder.appendingPathComponent("\(key).json", isDirectory: false)
  }

  /// `<App Group>/hfos-shared/`, made and marked to stay out of backups the first time it's needed.
  static func folder() -> URL? {
    guard
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: hfosAppGroup)
    else { return nil }
    var folder = container.appendingPathComponent("hfos-shared", isDirectory: true)
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try folder.setResourceValues(values)
      return folder
    } catch {
      return nil
    }
  }
}
