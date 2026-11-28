import SwiftUI
import UIKit

private let letterRows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"].map { $0.map(String.init) }
private let numberRows = ["1234567890", "-/:;()$&@\"", ".,?!'"].map { $0.map(String.init) }
private let symbolRows = ["[]{}#%^*+=", "_\\|~<>€£¥•", ".,?!'"].map { $0.map(String.init) }

/// The whole keyboard: the row on top (Templates, Links, the business), then the keys or a list in their place.
struct KeyboardView: View {
  @ObservedObject var model: KeyboardModel

  static let topHeight: CGFloat = 46

  static func rowHeight(landscape: Bool) -> CGFloat { landscape ? 40 : 54 }

  static func height(landscape: Bool) -> CGFloat { topHeight + rowHeight(landscape: landscape) * 4 + 8 }

  var body: some View {
    let palette = model.palette
    VStack(spacing: 0) {
      TopRow(model: model, palette: palette)
        .frame(height: Self.topHeight)
      Group {
        switch model.panel {
        case .keys:
          Keys(model: model, palette: palette, rowHeight: Self.rowHeight(landscape: model.landscape))
        case .templates:
          TemplateList(model: model, palette: palette)
        case .links:
          LinkList(model: model, palette: palette)
        case .businesses:
          BusinessList(model: model, palette: palette)
        }
      }
      .frame(height: Self.rowHeight(landscape: model.landscape) * 4 + 8)
    }
    .frame(maxWidth: .infinity)
    .background(palette.tray)
  }
}

// MARK: - The row on top

private struct TopRow: View {
  @ObservedObject var model: KeyboardModel
  let palette: Palette

  var body: some View {
    HStack(spacing: 6) {
      if model.asking != nil {
        Text(model.name.isEmpty ? (model.words?.askName ?? OwnWords.askName) : "\(model.name)|")
          .font(.system(size: 16))
          .foregroundColor(model.name.isEmpty ? palette.text2 : palette.text)
          .lineLimit(1)
          .truncationMode(.head)
          .padding(.horizontal, 12)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
          .background(RoundedRectangle(cornerRadius: 10).fill(palette.key))
          .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.accent, lineWidth: 2))
        Chip(label: model.words?.skip ?? OwnWords.skip, on: false, palette: palette) {
          model.finishAsking(skip: true)
        }
        Chip(label: model.words?.add ?? OwnWords.add, on: true, palette: palette) {
          model.finishAsking(skip: false)
        }
      } else if let note = model.note {
        Button(action: { model.dismissNote() }) {
          Text(note)
            .font(.system(size: 13.5))
            .foregroundColor(palette.warning)
            .lineLimit(2)
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10).fill(palette.warningSoft))
        }
        .buttonStyle(.plain)
      } else {
        Chip(
          label: model.words?.templates ?? OwnWords.templates, on: model.panel == .templates, palette: palette
        ) { model.show(.templates) }
        Chip(label: model.words?.links ?? OwnWords.links, on: model.panel == .links, palette: palette) {
          model.show(.links)
        }
        if let business = model.business, (model.data?.businesses.count ?? 0) > 1 {
          Chip(label: "\(business.name) ▾", on: model.panel == .businesses, palette: palette) {
            model.show(.businesses)
          }
          .frame(maxWidth: 150)
        }
        Spacer(minLength: 0)
        if model.panel != .keys {
          Chip(label: model.words?.letters ?? OwnWords.letters, on: false, palette: palette) {
            model.show(.keys)
          }
        }
      }
    }
    .padding(.horizontal, 6)
    .padding(.top, 6)
    .padding(.bottom, 2)
  }
}

private struct Chip: View {
  let label: String
  let on: Bool
  let palette: Palette
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(label)
        .font(.system(size: 14, weight: .semibold))
        .foregroundColor(on ? palette.onAccent : palette.accentText)
        .lineLimit(1)
        .padding(.horizontal, 14)
        .frame(maxHeight: .infinity)
        .background(Capsule().fill(on ? palette.accent : palette.accentSoft))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }
}

// MARK: - The keys

private struct Keys: View {
  @ObservedObject var model: KeyboardModel
  let palette: Palette
  let rowHeight: CGFloat

  private var rows: [[String]] {
    switch model.layer {
    case .letters: return letterRows
    case .numbers: return numberRows
    case .symbols: return symbolRows
    }
  }

  var body: some View {
    GeometryReader { geometry in
      let unit = (geometry.size.width - 6) / 10
      VStack(spacing: 0) {
        // Row 1: ten keys.
        HStack(spacing: 0) {
          ForEach(rows[0], id: \.self) { character($0, width: unit) }
        }
        // Row 2: nine letters inset by half a key, or ten numbers and symbols.
        HStack(spacing: 0) {
          ForEach(rows[1], id: \.self) { character($0, width: unit) }
        }
        // Row 3: shift (or the other symbols), the rest, delete.
        HStack(spacing: 0) {
          switch model.layer {
          case .letters:
            KeyCap(
              systemImage: model.shift == .lock ? "capslock.fill" : (model.shift == .once ? "shift.fill" : "shift"),
              label: "Shift", special: true, palette: palette, tint: model.shift == .off ? nil : palette.accent
            ) { model.tapShift() }
            .frame(width: unit * 1.5)
          case .numbers:
            KeyCap(text: "#+=", special: true, palette: palette) { model.switchLayer(.symbols) }
              .frame(width: unit * 1.5)
          case .symbols:
            KeyCap(text: "123", special: true, palette: palette) { model.switchLayer(.numbers) }
              .frame(width: unit * 1.5)
          }
          Spacer(minLength: 0)
          ForEach(rows[2], id: \.self) { character($0, width: model.layer == .letters ? unit : unit * 1.4) }
          Spacer(minLength: 0)
          KeyCap(
            systemImage: "delete.left", label: "Delete", special: true, palette: palette,
            onDown: { model.startDelete() }
          ) { model.stopDelete() }
          .frame(width: unit * 1.5)
        }
        // Row 4: letters or numbers, the next keyboard, space, return.
        HStack(spacing: 0) {
          if model.layer == .letters {
            KeyCap(text: "123", special: true, palette: palette) { model.switchLayer(.numbers) }
              .frame(width: unit * 1.5)
          } else {
            KeyCap(text: model.words?.letters ?? OwnWords.letters, special: true, palette: palette) {
              model.switchLayer(.letters)
            }
            .frame(width: unit * 1.5)
          }
          if model.showsGlobe {
            GlobeKey(palette: palette, model: model)
              .frame(width: unit * 1.2)
          }
          KeyCap(text: OwnWords.space, special: false, palette: palette, small: true) { model.type(" ") }
            .accessibilityLabel("space")
          KeyCap(
            text: model.asking != nil ? (model.words?.add ?? OwnWords.add) : model.returnLabel,
            special: true, palette: palette, small: true
          ) { model.enter() }
          .frame(width: unit * 2.3)
        }
      }
      .padding(.horizontal, 3)
      .padding(.vertical, 4)
      .frame(width: geometry.size.width, height: geometry.size.height)
    }
  }

  private func character(_ c: String, width: CGFloat) -> some View {
    let shown = model.layer == .letters && model.shift != .off ? c.uppercased() : c
    return KeyCap(text: shown, special: false, palette: palette) { model.type(c) }
      .frame(width: width, height: rowHeight)
  }
}

/// A key: its face inset in a cell that takes the touches around it too. Types when the finger lifts; `onDown`
/// is for delete, which starts on the touch and repeats while held.
private struct KeyCap: View {
  var text: String? = nil
  var systemImage: String? = nil
  var label: String? = nil
  let special: Bool
  let palette: Palette
  var tint: Color? = nil
  var small = false
  var onDown: (() -> Void)? = nil
  let onUp: () -> Void

  @State private var down = false

  init(text: String, special: Bool, palette: Palette, small: Bool = false, onUp: @escaping () -> Void) {
    self.text = text
    self.special = special
    self.palette = palette
    self.small = small
    self.onUp = onUp
  }

  init(
    systemImage: String, label: String, special: Bool, palette: Palette, tint: Color? = nil,
    onDown: (() -> Void)? = nil, onUp: @escaping () -> Void
  ) {
    self.systemImage = systemImage
    self.label = label
    self.special = special
    self.palette = palette
    self.tint = tint
    self.onDown = onDown
    self.onUp = onUp
  }

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 6)
        .fill(down ? (special ? palette.specialDown : palette.keyDown) : (special ? palette.special : palette.key))
        .shadow(color: Color.black.opacity(0.18), radius: 0, x: 0, y: 1)
        .padding(.horizontal, 3)
        .padding(.vertical, 5)
      if let systemImage {
        Image(systemName: systemImage)
          .font(.system(size: 18, weight: .medium))
          .foregroundColor(tint ?? palette.text)
      } else if let text {
        Text(text)
          .font(.system(size: small || text.count > 2 ? 15 : 22))
          .foregroundColor(small && !special ? palette.text2 : palette.text)
          .lineLimit(1)
          .minimumScaleFactor(0.6)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .contentShape(Rectangle())
    .gesture(
      DragGesture(minimumDistance: 0)
        .onChanged { _ in
          guard !down else { return }
          down = true
          onDown?()
        }
        .onEnded { _ in
          down = false
          onUp()
        }
    )
    .accessibilityElement()
    .accessibilityLabel(label ?? text ?? "")
    .accessibilityAddTraits(.isButton)
    .accessibilityAction {
      onDown?()
      onUp()
    }
  }
}

/// The next-keyboard key. iOS's own handler gives it the system's behaviour: a tap moves to the next keyboard, a
/// press and hold lists them all.
private struct GlobeKey: UIViewRepresentable {
  let palette: Palette
  @ObservedObject var model: KeyboardModel

  func makeUIView(context: Context) -> UIButton {
    let button = UIButton(type: .system)
    button.setImage(UIImage(systemName: "globe"), for: .normal)
    button.layer.cornerRadius = 6
    button.accessibilityLabel = "Next keyboard"
    if let controller = context.coordinator.controller {
      button.addTarget(
        controller, action: #selector(UIInputViewController.handleInputModeList(from:with:)), for: .allTouchEvents)
    }
    return button
  }

  func updateUIView(_ button: UIButton, context: Context) {
    button.tintColor = UIColor(palette.text)
    button.backgroundColor = UIColor(palette.special)
  }

  func makeCoordinator() -> Coordinator { Coordinator(model: model) }

  @MainActor
  final class Coordinator {
    weak var controller: UIInputViewController?
    init(model: KeyboardModel) { controller = model.inputController }
  }
}

// MARK: - Lists

private struct Message: View {
  let text: String
  let palette: Palette

  var body: some View {
    Text(text)
      .font(.system(size: 15))
      .foregroundColor(palette.text2)
      .multilineTextAlignment(.center)
      .padding(.horizontal, 24)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

private struct Row: View {
  let title: String
  let detail: String
  let palette: Palette
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.system(size: 15, weight: .semibold))
          .foregroundColor(palette.text)
          .lineLimit(1)
        if !detail.isEmpty {
          Text(detail)
            .font(.system(size: 13))
            .foregroundColor(palette.text2)
            .lineLimit(1)
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 9)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 10).fill(palette.key))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(detail.isEmpty ? title : "\(title). \(detail)")
  }
}

private struct TemplateList: View {
  @ObservedObject var model: KeyboardModel
  let palette: Palette

  var body: some View {
    if let message = model.unavailable {
      Message(text: message, palette: palette)
    } else if let templates = model.business?.templates, !templates.isEmpty {
      ScrollView {
        LazyVStack(spacing: 6) {
          ForEach(templates) { template in
            Row(title: template.name, detail: detail(template), palette: palette) { model.use(template) }
          }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
      }
    } else {
      Message(text: model.words?.noTemplates ?? OwnWords.noTemplates, palette: palette)
    }
  }

  private func detail(_ template: KbTemplate) -> String {
    [
      template.channel == "email" ? (model.words?.email ?? OwnWords.email) : nil,
      template.folder,
      template.preview.isEmpty ? nil : template.preview,
    ].compactMap { $0 }.joined(separator: " · ")
  }
}

private struct LinkList: View {
  @ObservedObject var model: KeyboardModel
  let palette: Palette

  var body: some View {
    if let message = model.unavailable {
      Message(text: message, palette: palette)
    } else if let links = model.business?.links, !links.isEmpty {
      ScrollView {
        LazyVStack(spacing: 6) {
          ForEach(links) { link in
            Row(title: link.name, detail: detail(link), palette: palette) { model.use(link) }
          }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
      }
    } else {
      Message(text: model.words?.noLinks ?? OwnWords.noLinks, palette: palette)
    }
  }

  private func detail(_ link: KbLink) -> String {
    link.kind == "booking" || link.kind == "form" ? "\(link.detail) · \(link.url)" : link.url
  }
}

private struct BusinessList: View {
  @ObservedObject var model: KeyboardModel
  let palette: Palette

  var body: some View {
    ScrollView {
      LazyVStack(spacing: 6) {
        ForEach(model.data?.businesses ?? []) { business in
          Row(
            title: business.id == model.business?.id ? "✓  \(business.name)" : business.name, detail: "",
            palette: palette
          ) { model.pick(business) }
        }
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 6)
    }
  }
}
