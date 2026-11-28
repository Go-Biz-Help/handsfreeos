import SwiftUI
import WidgetKit

/// Each widget as the phone's widget gallery lists it: core's WIDGET_GALLERY (packages/core/src/widgets/words.ts). A
/// phone test checks these say the same (apps/mobile/src/widgets/__tests__/native.test.ts).
struct GalleryEntry {
  let name: String
  let description: String
}

enum Gallery {
  static let myday = GalleryEntry(name: "My day", description: "Your next appointments, what needs you, and quick buttons, all in one.")
  static let today = GalleryEntry(name: "Today", description: "Your appointments today and the tasks that are due.")
  static let needs = GalleryEntry(name: "Needs you", description: "New leads, replies and anything else waiting on you.")
  static let quick = GalleryEntry(name: "Quick actions", description: "Add a contact, snap a receipt, start an invoice or ask HandsFreeOS.")
  static let money = GalleryEntry(name: "Money", description: "What came in, and what you’re still owed.")
  static let outreach = GalleryEntry(name: "Social Outreach", description: "Today’s first messages against your goal, and replies waiting for your OK.")
  static let ask = GalleryEntry(name: "Ask HandsFreeOS", description: "One tap and talk to the Assistant.")
  static let lock = GalleryEntry(name: "HandsFreeOS", description: "Your next appointment and what needs you.")
}

/// What a widget says with no copy to read: core's WIDGET_EMPTY_WORDS, which the same test checks.
enum EmptyWords {
  static let signedOut = "Open HandsFreeOS to see your day here."
  static let locked = "Unlock your phone to see HandsFreeOS."
}

/// Where a tap goes with no copy: the app.
let appUrl = "handsfreeos://"

/// The brand's colours (apps/mobile/src/theme/tokens.ts), for a widget: a card, its text, and the tones core names.
struct WPalette {
  let bg: Color
  let soft: Color
  let text: Color
  let text2: Color
  let accent: Color
  let accentText: Color
  let accentSoft: Color
  let good: Color
  let danger: Color

  init(dark: Bool) {
    bg = Color(hex: dark ? 0x191D25 : 0xFFFFFF)
    soft = Color(hex: dark ? 0x20252E : 0xF2F4F8)
    text = Color(hex: dark ? 0xF2F4F8 : 0x191D25)
    text2 = Color(hex: dark ? 0xA0A5AE : 0x5B616A)
    accent = Color(hex: 0x2D69D8)
    accentText = Color(hex: dark ? 0x7CA4EB : 0x2D69D8)
    accentSoft = Color(hex: dark ? 0x1F2D48 : 0xE9F0FD)
    good = Color(hex: dark ? 0x3CCF7A : 0x008743)
    danger = Color(hex: dark ? 0xFF7B73 : 0xC43335)
  }

  /// A tone core gave a row or a figure.
  func tone(_ tone: String?, otherwise: Color) -> Color {
    switch tone {
    case "accent": return accentText
    case "danger": return danger
    case "good": return good
    case "muted": return text2
    default: return otherwise
    }
  }
}

extension Color {
  init(hex: UInt32) {
    self.init(
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255
    )
  }
}

extension View {
  /// The widget's background: `containerBackground` from iOS 17, which also gives the system's margins; before
  /// that, a plain background with our own padding.
  @ViewBuilder
  func widgetBackground(_ color: Color) -> some View {
    if #available(iOS 17.0, *) {
      containerBackground(for: .widget) { color }
    } else {
      padding(16).background(color)
    }
  }

  /// The lock screen's widgets draw on the system's own background, which iOS 17 still asks to be named.
  @ViewBuilder
  func accessoryBackground() -> some View {
    if #available(iOS 17.0, *) {
      containerBackground(for: .widget) { Color.clear }
    } else {
      self
    }
  }
}

/// The SF Symbol for each of Quick actions' buttons, by core's `WidgetActionKey`.
func actionSymbol(_ key: String) -> String {
  switch key {
  case "contact": return "person.crop.circle.badge.plus"
  case "receipt": return "camera"
  case "invoice": return "doc.text"
  case "calendar": return "calendar"
  case "tasks": return "checklist"
  case "ask": return "mic.fill"
  default: return "circle"
  }
}

/// What the widget gallery shows before anyone has signed in: made-up, nameless, and in core's shape (the phone test
/// checks the JSON below against `buildWidgetsData`'s keys).
enum Sample {
  static let data: WidgetsData? = try? JSONDecoder().decode(WidgetsData.self, from: Data(json.utf8))

  // SAMPLE-JSON-START
  static let json = """
    {"v":1,"business":{"id":"sample","name":"Your business"},"showBusiness":false,"hideNames":true,
    "updatedAt":"2026-11-28T15:00:00.000Z","url":"handsfreeos://",
    "moments":[{"at":"2026-11-28T15:00:00.000Z","face":{
    "today":{"title":"Today","date":"Fri, Nov 28","count":3,"countWords":"3 appointments","rows":[
    {"id":"1","lead":"Now","title":"Duct cleaning","detail":"Houston","tone":"accent","url":"handsfreeos://"},
    {"id":"2","lead":"11:00 AM","title":"AC tune-up","detail":"Katy","tone":null,"url":"handsfreeos://"},
    {"id":"3","lead":"2:30 PM","title":"Estimate","detail":"Sugar Land","tone":null,"url":"handsfreeos://"}],
    "more":{"1":"+2 more","3":null,"6":null},"empty":"Nothing else today","url":"handsfreeos://",
    "tasks":"2 tasks due today","tasksUrl":"handsfreeos://"},
    "needs":{"title":"Needs you","count":4,"countWords":"4 need you","urgent":1,"rows":[
    {"id":"a","lead":"Urgent","title":"New lead","detail":null,"tone":"danger","url":"handsfreeos://"},
    {"id":"b","lead":"","title":"Unread message","detail":null,"tone":null,"url":"handsfreeos://"},
    {"id":"c","lead":"","title":"Quote to follow up","detail":null,"tone":null,"url":"handsfreeos://"},
    {"id":"d","lead":"","title":"Review to answer","detail":null,"tone":null,"url":"handsfreeos://"}],
    "more":{"1":"+3 more","3":"+1 more","6":null},"empty":"You’re all caught up","url":"handsfreeos://"},
    "money":{"title":"Money","allowed":true,"figures":[
    {"label":"Owed","value":"$4,200","tone":null},{"label":"Late","value":"$900","tone":"danger"},
    {"label":"In today","value":"$350","tone":"good"},{"label":"Last 7 days","value":"$2,100","tone":null}],
    "note":"5 invoices waiting · 1 is late","url":"handsfreeos://"},
    "quick":{"title":"Quick actions","actions":[
    {"key":"contact","label":"Add contact","url":"handsfreeos://"},
    {"key":"receipt","label":"Snap receipt","url":"handsfreeos://"},
    {"key":"invoice","label":"New invoice","url":"handsfreeos://"},
    {"key":"ask","label":"Ask","url":"handsfreeos://"}]},
    "ask":{"title":"Ask HandsFreeOS","hint":"Tap and talk","url":"handsfreeos://"},
    "lock":{"line":"11:00 AM · AC tune-up","time":"11:00 AM","what":"AC tune-up","needs":4,"needsWords":"4 need you"},
    "addons":{"outreach":{"title":"Social Outreach","on":true,"figures":[
    {"label":"First messages","value":"6 of 20","tone":null},{"label":"Replies to OK","value":"2","tone":"accent"},
    {"label":"To OK","value":"3","tone":"accent"}],"note":"5 messages wait for your OK.","url":"handsfreeos://"}}}}],
    "words":{"updated":"Updated","signedOut":"Open HandsFreeOS to see your day here.","locked":"Unlock your phone to see HandsFreeOS."}}
    """
  // SAMPLE-JSON-END
}
