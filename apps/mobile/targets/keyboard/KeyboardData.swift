import Foundation

/// The copy of templates and links the app keeps for the keyboard: core's `KeyboardData`
/// (packages/core/src/keyboard), version 1, written by modules/hfos-shared under the key "keyboard". The app works
/// everything out; the keyboard only joins a template's parts.

/// Must match core's KEYBOARD_DATA_VERSION.
let keyboardDataVersion = 1

struct KeyboardData: Decodable {
  let v: Int
  /// The business the app has open.
  let current: String?
  let businesses: [KbBusiness]
  let words: KbWords?
}

struct KbBusiness: Decodable, Identifiable {
  let id: String
  let name: String
  let templates: [KbTemplate]
  let links: [KbLink]
}

struct KbTemplate: Decodable, Identifiable {
  let id: String
  let name: String
  let folder: String?
  let channel: String
  let parts: [KbPart]
  let asks: Bool
  let preview: String
  let note: String?

  /// The words to type, with `name` in place of each first name (or the fallback when it's blank).
  func fill(_ name: String) -> String {
    let typed = name.trimmingCharacters(in: .whitespaces)
    return parts.map { part in
      switch part {
      case .text(let words):
        return words
      case .ask(let fallback, let transform):
        let value = typed.isEmpty ? fallback : typed
        switch transform {
        case "upper": return value.uppercased()
        case "lower": return value.lowercased()
        default: return value
        }
      }
    }.joined()
  }
}

/// Words, or a first name to ask for (with its fallback, and an upper or lower filter).
enum KbPart: Decodable {
  case text(String)
  case ask(fallback: String, transform: String?)

  private enum Keys: String, CodingKey {
    case text, fallback, transform
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: Keys.self)
    if let words = try container.decodeIfPresent(String.self, forKey: .text) {
      self = .text(words)
    } else {
      self = .ask(
        fallback: try container.decodeIfPresent(String.self, forKey: .fallback) ?? "there",
        transform: try container.decodeIfPresent(String.self, forKey: .transform)
      )
    }
  }
}

struct KbLink: Decodable, Identifiable {
  let kind: String
  let name: String
  let detail: String
  let url: String
  var id: String { "\(kind)|\(url)|\(name)" }
}

/// The words the app sent (core's KEYBOARD_PANEL_WORDS). Every one is optional, so the keyboard's own stand in.
struct KbWords: Decodable {
  let templates: String?
  let links: String?
  let letters: String?
  let noTemplates: String?
  let noLinks: String?
  let askName: String?
  let add: String?
  let skip: String?
  let email: String?
  let kinds: [String: String]?
}

/// What the keyboard can show.
enum KeyboardLoad {
  /// Full Access is off, so the App Group can't be read.
  case noAccess
  /// Nothing yet: nobody has signed in to the app on this phone, or they signed out.
  case missing
  /// Written by a newer app than this keyboard knows.
  case newer
  case ready(KeyboardData)
}

/// The App Group the app shares with its keyboard and widgets (app.json `ios.entitlements`; the app's side is
/// modules/hfos-shared/ios/HfosSharedModule.swift).
enum SharedStore {
  static let appGroup = "group.com.gobizhelp.handsfreeos"

  private struct Version: Decodable {
    let v: Int
  }

  static func folder() -> URL? {
    FileManager.default
      .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
      .appendingPathComponent("hfos-shared", isDirectory: true)
  }

  static func load(hasFullAccess: Bool) -> KeyboardLoad {
    guard hasFullAccess else { return .noAccess }
    guard let file = folder()?.appendingPathComponent("keyboard.json"),
      let data = try? Data(contentsOf: file)
    else { return .missing }
    guard let version = try? JSONDecoder().decode(Version.self, from: data) else { return .missing }
    if version.v > keyboardDataVersion { return .newer }
    guard version.v == keyboardDataVersion,
      let decoded = try? JSONDecoder().decode(KeyboardData.self, from: data)
    else { return .missing }
    return .ready(decoded)
  }

  /// Tells the app's Settings → Phone keyboard screen that the keyboard opened with Full Access. Never anything typed.
  static func markSeen() {
    guard let folder = folder() else { return }
    let stamp = ISO8601DateFormatter().string(from: Date())
    let json = "{\"at\":\"\(stamp)\",\"fullAccess\":true}"
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try? Data(json.utf8).write(
      to: folder.appendingPathComponent("keyboard-seen.json"),
      options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
    )
  }

  // The business picked on the keyboard, and which business the app had open when it was picked: the keyboard's own,
  // in its own defaults (no App Group needed).
  private static let pickKey = "hfos.keyboard.pick"

  /// The pick while the app still has open the business it had then; otherwise the business the app has open now.
  static func businessToShow(_ data: KeyboardData) -> KbBusiness? {
    let pick = UserDefaults.standard.string(forKey: pickKey)?.components(separatedBy: "|")
    let picked = (pick?.count == 2 && pick?[1] == (data.current ?? "")) ? pick?[0] : nil
    return data.businesses.first { $0.id == picked }
      ?? data.businesses.first { $0.id == data.current }
      ?? data.businesses.first
  }

  static func pick(_ businessId: String, in data: KeyboardData) {
    UserDefaults.standard.set("\(businessId)|\(data.current ?? "")", forKey: pickKey)
  }
}
