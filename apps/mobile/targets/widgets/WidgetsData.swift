import Foundation

/// The copy the app keeps for the widgets: core's `WidgetsData` (packages/core/src/widgets/data.ts), version 1,
/// written by modules/hfos-shared under the key "widgets". Core works out every word, count and link, for each moment
/// from now to the end of tomorrow; a widget only picks the moment it's in.

/// Must match core's WIDGETS_DATA_VERSION. The app and its widgets ship in one build, so the copy is never newer.
let widgetsDataVersion = 1

struct WidgetsData: Decodable {
  let v: Int
  let business: WBusiness
  let showBusiness: Bool
  let hideNames: Bool
  let updatedAt: String
  let url: String
  let moments: [WMoment]
  let words: WWords?

  /// The face to show at `date`: the latest moment that has begun, or the first while none has.
  func face(at date: Date) -> WFace {
    var face = moments[0].face
    for moment in moments {
      guard let at = WDate.parse(moment.at), at <= date else { break }
      face = moment.face
    }
    return face
  }
}

struct WBusiness: Decodable {
  let id: String
  let name: String
}

struct WWords: Decodable {
  let updated: String?
}

struct WMoment: Decodable {
  let at: String
  let face: WFace
}

struct WFace: Decodable {
  let today: WToday
  let needs: WNeeds
  let money: WMoney
  let quick: WQuick
  let ask: WAsk
  let lock: WLock
  let addons: [String: WAddon]
}

struct WRow: Decodable, Identifiable {
  let id: String
  /// "2:30 PM", "Now", "Urgent", or empty.
  let lead: String
  let title: String
  let detail: String?
  let tone: String?
  let url: String
}

/// What the Today and Needs you lists have in common.
protocol WList {
  var title: String { get }
  var count: Int { get }
  var countWords: String { get }
  var rows: [WRow] { get }
  var more: [String: String?] { get }
  var empty: String { get }
  var url: String { get }
}

extension WList {
  /// "+4 more" under the first `shown` rows (1, 3 or 6), or nil when they all fit.
  func moreWords(shown: Int) -> String? {
    more["\(shown)"] ?? nil
  }

  /// Whether any row has something in the left column, so the column is kept for all of them.
  var hasLead: Bool { rows.contains { !$0.lead.isEmpty } }
}

struct WToday: Decodable, WList {
  let title: String
  /// "Fri, Nov 28".
  let date: String
  let count: Int
  let countWords: String
  let rows: [WRow]
  let more: [String: String?]
  let empty: String
  let url: String
  /// "3 tasks due today", or nil with none.
  let tasks: String?
  let tasksUrl: String
}

struct WNeeds: Decodable, WList {
  let title: String
  let count: Int
  let countWords: String
  let rows: [WRow]
  let more: [String: String?]
  let empty: String
  let url: String
  let urgent: Int
}

struct WFigure: Decodable, Identifiable {
  let label: String
  let value: String
  let tone: String?
  var id: String { label }
}

struct WMoney: Decodable {
  let title: String
  let allowed: Bool
  let figures: [WFigure]
  let note: String?
  let url: String
}

struct WAddon: Decodable {
  let title: String
  let on: Bool
  let figures: [WFigure]
  let note: String?
  let url: String
}

struct WAction: Decodable, Identifiable {
  /// contact, receipt, invoice, calendar, tasks or ask: which icon to draw.
  let key: String
  let label: String
  let url: String
  var id: String { key }
}

struct WQuick: Decodable {
  let title: String
  let actions: [WAction]
}

struct WAsk: Decodable {
  let title: String
  let hint: String
  let url: String
}

/// The lock screen's, which never names anyone.
struct WLock: Decodable {
  let line: String
  let time: String?
  let what: String?
  let needs: Int
  let needsWords: String
}

/// Core writes dates with `toISOString()`, which has milliseconds.
enum WDate {
  private static let withFraction: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()
  private static let plain = ISO8601DateFormatter()

  static func parse(_ text: String) -> Date? {
    withFraction.date(from: text) ?? plain.date(from: text)
  }
}

/// What a widget can show.
enum WidgetsLoad {
  /// Nothing yet: nobody has signed in on this phone, they signed out, or no business has been opened.
  case missing
  /// The copy is there but the phone hasn't been unlocked since it restarted, so iOS keeps the file closed.
  case locked
  case ready(WidgetsData)
}

/// The App Group the app shares with its keyboard and widgets (app.json `ios.entitlements`; the app's side is
/// modules/hfos-shared/ios/HfosSharedModule.swift).
enum WidgetsStore {
  static let appGroup = "group.com.gobizhelp.handsfreeos"

  private struct Version: Decodable {
    let v: Int
  }

  static func load() -> WidgetsLoad {
    guard
      let file = FileManager.default
        .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
        .appendingPathComponent("hfos-shared", isDirectory: true)
        .appendingPathComponent("widgets.json")
    else { return .missing }
    guard FileManager.default.fileExists(atPath: file.path) else { return .missing }
    // There but unreadable: protected until the first unlock after a restart.
    guard let data = try? Data(contentsOf: file) else { return .locked }
    guard let version = try? JSONDecoder().decode(Version.self, from: data),
      version.v == widgetsDataVersion,
      let decoded = try? JSONDecoder().decode(WidgetsData.self, from: data),
      !decoded.moments.isEmpty
    else { return .missing }
    return .ready(decoded)
  }
}
