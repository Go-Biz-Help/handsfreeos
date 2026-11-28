import Combine
import SwiftUI
import UIKit

/// The words only the keyboard says: before it can read the app's copy (Full Access off, nobody signed in) or when
/// that copy is newer than this keyboard. Everything else comes from the app (core's KEYBOARD_PANEL_WORDS).
enum OwnWords {
  static let templates = "Templates"
  static let links = "Links"
  static let letters = "ABC"
  static let noAccess =
    "Turn on Allow Full Access to see your templates and links: Settings → General → Keyboard → Keyboards → HandsFreeOS. Letters work without it."
  static let missing = "Open HandsFreeOS and sign in to see your templates and links here."
  static let newer = "Update HandsFreeOS from the App Store to see your templates and links here."
  static let noTemplates = "No templates yet."
  static let noLinks = "No links yet."
  static let askName = "Their first name"
  static let add = "Add"
  static let skip = "Skip"
  static let email = "Email"
  static let space = "HandsFreeOS"
}

/// Everything the keyboard knows and does; the views only draw it.
@MainActor
final class KeyboardModel: ObservableObject {
  enum Layer { case letters, numbers, symbols }
  enum Shift { case off, once, lock }
  enum Panel { case keys, templates, links, businesses }

  @Published var layer: Layer = .letters
  @Published var shift: Shift = .off
  @Published var panel: Panel = .keys
  @Published var load: KeyboardLoad = .missing
  @Published var business: KbBusiness?
  /// A template waiting for a first name, and what's been typed for it so far.
  @Published var asking: KbTemplate?
  @Published var name = ""
  /// "Fill in {{lead.title}} before you send it.", for a few seconds after such a template goes in.
  @Published var note: String?
  @Published var returnLabel = "return"
  @Published var dark = false
  @Published var landscape = false

  private weak var controller: UIInputViewController?
  private var lastShiftTap = Date.distantPast
  private var lastSpaceAt = Date.distantPast
  private var repeatTask: Task<Void, Never>?
  private var noteTask: Task<Void, Never>?

  init(controller: UIInputViewController) {
    self.controller = controller
  }

  private var proxy: UITextDocumentProxy? { controller?.textDocumentProxy }

  /// For the next-keyboard key, which hands its touches to iOS's own handler on the controller.
  var inputController: UIInputViewController? { controller }

  var words: KbWords? {
    if case .ready(let data) = load { return data.words }
    return nil
  }

  var data: KeyboardData? {
    if case .ready(let data) = load { return data }
    return nil
  }

  /// iOS asks for a next-keyboard key only when the phone has no other way to switch (Face ID phones show a globe below).
  var showsGlobe: Bool { controller?.needsInputModeSwitchKey ?? true }

  var palette: Palette { Palette(dark: dark) }

  // MARK: - Opening and closing

  func open() {
    let hasFullAccess = controller?.hasFullAccess ?? false
    load = SharedStore.load(hasFullAccess: hasFullAccess)
    if hasFullAccess { SharedStore.markSeen() }
    if case .ready(let data) = load {
      business = SharedStore.businessToShow(data)
    } else {
      business = nil
    }
    layer = .letters
    panel = .keys
    asking = nil
    name = ""
    note = nil
    fieldChanged()
  }

  func close() {
    stopDelete()
    noteTask?.cancel()
    asking = nil
    name = ""
  }

  /// The field changed or the cursor moved: its colours, its return key and whether a capital comes next.
  func fieldChanged() {
    dark = proxy?.keyboardAppearance == .dark || controller?.traitCollection.userInterfaceStyle == .dark
    returnLabel = Self.label(for: proxy?.returnKeyType ?? .default)
    autoCapital()
  }

  private static func label(for type: UIReturnKeyType) -> String {
    switch type {
    case .go: return "go"
    case .google, .yahoo, .search: return "search"
    case .join: return "join"
    case .next: return "next"
    case .route: return "route"
    case .send: return "send"
    case .done: return "done"
    case .emergencyCall: return "call"
    case .continue: return "continue"
    default: return "return"
    }
  }

  // MARK: - Keys

  func tapShift() {
    let now = Date()
    switch shift {
    case .off: shift = .once
    case .once: shift = now.timeIntervalSince(lastShiftTap) < 0.35 ? .lock : .off
    case .lock: shift = .off
    }
    lastShiftTap = now
  }

  func switchLayer(_ next: Layer) {
    layer = next
  }

  func nextKeyboard() {
    controller?.advanceToNextInputMode()
  }

  private func wantsCapital() -> Bool {
    guard let proxy else { return false }
    let before = proxy.documentContextBeforeInput ?? ""
    switch proxy.autocapitalizationType ?? .sentences {
    case .none:
      return false
    case .allCharacters:
      return true
    case .words:
      return before.isEmpty || before.last?.isWhitespace == true
    case .sentences:
      if before.isEmpty || before.last?.isNewline == true { return true }
      guard before.last?.isWhitespace == true else { return false }
      let trimmed = before.trimmingCharacters(in: .whitespaces)
      guard let last = trimmed.last else { return true }
      return last == "." || last == "!" || last == "?"
    @unknown default:
      return false
    }
  }

  /// After anything but a letter: a capital where the field wants one, unless caps lock is on.
  private func autoCapital() {
    guard shift != .lock, asking == nil else { return }
    shift = wantsCapital() ? .once : .off
  }

  func type(_ character: String) {
    if asking != nil {
      if name.count < 40 {
        name += shift != .off ? character.uppercased() : character
      }
      if shift == .once { shift = .off }
      return
    }
    guard let proxy else { return }
    if character == " " {
      let now = Date()
      let before = proxy.documentContextBeforeInput ?? ""
      let tail = Array(before.suffix(2))
      // Two spaces after a word end the sentence, as on the phone's own keyboard.
      if now.timeIntervalSince(lastSpaceAt) < 0.8, tail.count == 2, tail[0].isLetter || tail[0].isNumber,
        tail[1] == " "
      {
        proxy.deleteBackward()
        proxy.insertText(". ")
        lastSpaceAt = .distantPast
      } else {
        proxy.insertText(" ")
        lastSpaceAt = now
      }
      autoCapital()
      return
    }
    lastSpaceAt = .distantPast
    if character.first?.isLetter == true {
      proxy.insertText(shift != .off ? character.uppercased() : character)
      if shift == .once { shift = .off }
    } else {
      proxy.insertText(character)
      // A sentence's end goes back to the letters, as the phone's own keyboard does.
      if layer != .letters, [".", "?", "!", "'"].contains(character) { layer = .letters }
      autoCapital()
    }
  }

  func deleteBackward() {
    if asking != nil {
      if !name.isEmpty { name.removeLast() }
      return
    }
    proxy?.deleteBackward()
    autoCapital()
  }

  /// Delete: once on the touch, then again and again while it's held.
  func startDelete() {
    deleteBackward()
    repeatTask?.cancel()
    repeatTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 400_000_000)
      while !Task.isCancelled {
        self?.deleteBackward()
        try? await Task.sleep(nanoseconds: 70_000_000)
      }
    }
  }

  func stopDelete() {
    repeatTask?.cancel()
    repeatTask = nil
  }

  func enter() {
    if asking != nil {
      finishAsking(skip: false)
      return
    }
    proxy?.insertText("\n")
    autoCapital()
  }

  // MARK: - Templates and links

  func show(_ next: Panel) {
    panel = (panel == next && next != .keys) ? .keys : next
  }

  func use(_ template: KbTemplate) {
    if template.asks {
      asking = template
      name = ""
      // A name starts with a capital.
      shift = .once
      layer = .letters
      panel = .keys
      return
    }
    typeTemplate(template, name: "")
  }

  func finishAsking(skip: Bool) {
    guard let template = asking else { return }
    let typed = skip ? "" : name
    asking = nil
    name = ""
    typeTemplate(template, name: typed)
  }

  private func typeTemplate(_ template: KbTemplate, name: String) {
    proxy?.insertText(template.fill(name))
    panel = .keys
    layer = .letters
    note = template.note
    noteTask?.cancel()
    if note != nil {
      noteTask = Task { @MainActor [weak self] in
        try? await Task.sleep(nanoseconds: 6_000_000_000)
        if !Task.isCancelled { self?.note = nil }
      }
    }
    shift = .off
    autoCapital()
  }

  /// A link goes in with a space before it when it follows a word.
  func use(_ link: KbLink) {
    let before = proxy?.documentContextBeforeInput ?? ""
    let spaced = before.last.map { !$0.isWhitespace } ?? false
    proxy?.insertText(spaced ? " \(link.url)" : link.url)
    panel = .keys
    autoCapital()
  }

  func pick(_ chosen: KbBusiness) {
    guard let data else { return }
    SharedStore.pick(chosen.id, in: data)
    business = chosen
    panel = .templates
  }

  func dismissNote() {
    noteTask?.cancel()
    note = nil
  }

  /// The panel's words when there's nothing to list.
  var unavailable: String? {
    switch load {
    case .noAccess: return OwnWords.noAccess
    case .missing: return OwnWords.missing
    case .newer: return OwnWords.newer
    case .ready: return nil
    }
  }
}

/// The brand's colours (apps/mobile/src/theme/tokens.ts), for a keyboard: a grey tray, keys a step off it.
struct Palette {
  let tray: Color
  let key: Color
  let keyDown: Color
  let special: Color
  let specialDown: Color
  let text: Color
  let text2: Color
  let accent: Color
  let onAccent: Color
  let accentSoft: Color
  let accentText: Color
  let warning: Color
  let warningSoft: Color

  init(dark: Bool) {
    tray = Color(hex: dark ? 0x15191F : 0xE3E6EB)
    key = Color(hex: dark ? 0x2C3139 : 0xFFFFFF)
    keyDown = Color(hex: dark ? 0x3A4049 : 0xD2D6DD)
    special = Color(hex: dark ? 0x20252E : 0xC4C9D1)
    specialDown = Color(hex: dark ? 0x2C3139 : 0xAEB4BE)
    text = Color(hex: dark ? 0xF2F4F8 : 0x191D25)
    text2 = Color(hex: dark ? 0xA0A5AE : 0x5B616A)
    accent = Color(hex: 0x2D69D8)
    onAccent = Color(hex: 0xFFFFFF)
    accentSoft = Color(hex: dark ? 0x1F2D48 : 0xE9F0FD)
    accentText = Color(hex: dark ? 0x7CA4EB : 0x2D69D8)
    warning = Color(hex: dark ? 0xF5C97A : 0x6B4300)
    warningSoft = Color(hex: dark ? 0x2D2210 : 0xFFEDD8)
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
