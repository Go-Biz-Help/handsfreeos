import SwiftUI
import WidgetKit

// How each widget lays out core's words. Small widgets open one place (`widgetURL`); medium and large ones open each
// row (`Link`). Names are marked private, so iOS hides them where it hides private things (StandBy, a locked phone).

/// Opens `url` when tapped, on the widgets that allow more than one place.
struct Tap<Content: View>: View {
  let url: String
  @ViewBuilder let label: () -> Content

  var body: some View {
    if let destination = URL(string: url) {
      Link(destination: destination, label: label)
    } else {
      label()
    }
  }
}

/// Every widget's frame: its background, and what it says without a copy.
struct Shell<Content: View>: View {
  let entry: HfosEntry
  let content: (WidgetsData, WFace, WPalette) -> Content
  @Environment(\.colorScheme) private var scheme

  init(entry: HfosEntry, @ViewBuilder content: @escaping (WidgetsData, WFace, WPalette) -> Content) {
    self.entry = entry
    self.content = content
  }

  var body: some View {
    let palette = WPalette(dark: scheme == .dark)
    Group {
      switch entry.state {
      case .missing:
        EmptyNote(text: EmptyWords.signedOut, palette: palette)
      case .locked:
        EmptyNote(text: EmptyWords.locked, palette: palette)
      case .ready(let data, let face, redact: let redact):
        content(data, face, palette)
          .redacted(reason: redact ? .placeholder : [])
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .widgetBackground(palette.bg)
  }
}

/// Where a tap on the widget goes (on small widgets, the only place): `pick`'s link, or the app with no copy.
func tapUrl(_ entry: HfosEntry, _ pick: (WidgetsData, WFace) -> String) -> URL? {
  if case .ready(let data, let face, redact: _) = entry.state { return URL(string: pick(data, face)) }
  return URL(string: appUrl)
}

struct EmptyNote: View {
  let text: String
  let palette: WPalette

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("HandsFreeOS").font(.footnote.weight(.semibold)).foregroundColor(palette.accentText)
      Text(text).font(.subheadline).foregroundColor(palette.text).fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
    }
  }
}

/// The widget's name on the left; the date, a count or the business on the right.
struct Header: View {
  let title: String
  let trailing: String?
  let palette: WPalette

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text(title).font(.footnote.weight(.semibold)).foregroundColor(palette.accentText).lineLimit(1)
      Spacer(minLength: 4)
      if let trailing {
        Text(trailing).font(.caption).foregroundColor(palette.text2).lineLimit(1)
      }
    }
  }
}

/// The business's name, when the person has more than one.
struct BusinessLine: View {
  let data: WidgetsData
  let palette: WPalette

  var body: some View {
    if data.showBusiness {
      Text(data.business.name).font(.caption2).foregroundColor(palette.text2).lineLimit(1)
    }
  }
}

struct RowView: View {
  let row: WRow
  /// The left column's width, or 0 with none.
  let leadWidth: CGFloat
  /// Whether the title and line may name someone.
  let names: Bool
  let palette: WPalette

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      if leadWidth > 0 {
        Text(row.lead)
          .font(.caption.weight(.semibold))
          .foregroundColor(palette.tone(row.tone, otherwise: palette.text2))
          .lineLimit(1)
          .minimumScaleFactor(0.8)
          .frame(width: leadWidth, alignment: .leading)
      }
      VStack(alignment: .leading, spacing: 1) {
        Text(row.title)
          .font(.subheadline.weight(.semibold))
          .foregroundColor(palette.text)
          .lineLimit(1)
          .privacySensitive(names)
        if let detail = row.detail {
          Text(detail)
            .font(.caption)
            .foregroundColor(palette.text2)
            .lineLimit(1)
            .privacySensitive(names)
        }
      }
      Spacer(minLength: 0)
    }
  }
}

/// Up to `shown` rows of a list, each opening its own place, then "+N more"; or the list's empty words.
struct Rows<L: WList>: View {
  let list: L
  let shown: Int
  let names: Bool
  let palette: WPalette
  var spacing: CGFloat = 8

  var body: some View {
    VStack(alignment: .leading, spacing: spacing) {
      if list.rows.isEmpty {
        Text(list.empty).font(.subheadline).foregroundColor(palette.text2)
      } else {
        ForEach(Array(list.rows.prefix(shown))) { row in
          Tap(url: row.url) {
            RowView(row: row, leadWidth: list.hasLead ? 58 : 0, names: names, palette: palette)
          }
        }
        if let more = list.moreWords(shown: shown) {
          Tap(url: list.url) {
            Text(more).font(.caption.weight(.medium)).foregroundColor(palette.accentText)
          }
        }
      }
    }
  }
}

struct FigureView: View {
  let figure: WFigure
  var big = false
  let palette: WPalette

  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(figure.value)
        .font(big ? .title2.weight(.bold) : .headline)
        .foregroundColor(palette.tone(figure.tone, otherwise: palette.text))
        .lineLimit(1)
        .minimumScaleFactor(0.6)
      Text(figure.label).font(.caption).foregroundColor(palette.text2).lineLimit(1)
    }
  }
}

/// The time left of an "Updated" line: when the app last wrote the copy.
struct UpdatedLine: View {
  let data: WidgetsData
  let palette: WPalette

  var body: some View {
    if let words = data.words?.updated, let at = WDate.parse(data.updatedAt) {
      (Text(words + " ") + Text(at, style: .time))
        .font(.caption2)
        .foregroundColor(palette.text2)
    }
  }
}

// MARK: - Today

struct TodayView: View {
  let entry: HfosEntry

  var body: some View {
    Shell(entry: entry) { data, face, palette in
      TodayContent(data: data, face: face, palette: palette)
    }
    .widgetURL(tapUrl(entry) { _, face in face.today.rows.first?.url ?? face.today.url })
  }
}

struct TodayContent: View {
  let data: WidgetsData
  let face: WFace
  let palette: WPalette
  @Environment(\.widgetFamily) private var family

  var body: some View {
    let today = face.today
    let names = !data.hideNames
    switch family {
    case .systemSmall:
      VStack(alignment: .leading, spacing: 4) {
        Header(title: today.title, trailing: today.date, palette: palette)
        if let first = today.rows.first {
          Text(first.lead)
            .font(.title3.weight(.bold))
            .foregroundColor(palette.tone(first.tone, otherwise: palette.text))
            .lineLimit(1)
            .padding(.top, 2)
          Text(first.title)
            .font(.subheadline.weight(.semibold))
            .foregroundColor(palette.text)
            .lineLimit(2)
            .privacySensitive(names)
          if let detail = first.detail {
            Text(detail).font(.caption).foregroundColor(palette.text2).lineLimit(1).privacySensitive(names)
          }
        } else {
          Text(today.empty).font(.subheadline).foregroundColor(palette.text2).padding(.top, 2)
        }
        Spacer(minLength: 0)
        Text(today.moreWords(shown: 1) ?? today.tasks ?? today.countWords)
          .font(.caption)
          .foregroundColor(palette.text2)
          .lineLimit(1)
      }
    case .systemLarge:
      VStack(alignment: .leading, spacing: 10) {
        Header(title: today.title, trailing: "\(today.date) · \(today.countWords)", palette: palette)
        BusinessLine(data: data, palette: palette)
        Rows(list: today, shown: 6, names: names, palette: palette, spacing: 10)
        Spacer(minLength: 0)
        if let tasks = today.tasks {
          Tap(url: today.tasksUrl) {
            Label(tasks, systemImage: "checklist")
              .font(.footnote.weight(.medium))
              .foregroundColor(palette.text)
          }
        }
        UpdatedLine(data: data, palette: palette)
      }
    default:
      VStack(alignment: .leading, spacing: 8) {
        Header(title: today.title, trailing: "\(today.date) · \(today.countWords)", palette: palette)
        Rows(list: today, shown: 3, names: names, palette: palette)
        Spacer(minLength: 0)
        if today.moreWords(shown: 3) == nil, let tasks = today.tasks {
          Tap(url: today.tasksUrl) {
            Text(tasks).font(.caption.weight(.medium)).foregroundColor(palette.text2)
          }
        }
      }
    }
  }
}

// MARK: - Needs you

struct NeedsView: View {
  let entry: HfosEntry

  var body: some View {
    Shell(entry: entry) { data, face, palette in
      NeedsContent(data: data, face: face, palette: palette)
    }
    .widgetURL(tapUrl(entry) { _, face in face.needs.rows.first?.url ?? face.needs.url })
  }
}

struct NeedsContent: View {
  let data: WidgetsData
  let face: WFace
  let palette: WPalette
  @Environment(\.widgetFamily) private var family

  var body: some View {
    let needs = face.needs
    let names = !data.hideNames
    switch family {
    case .systemSmall:
      VStack(alignment: .leading, spacing: 4) {
        Header(title: needs.title, trailing: nil, palette: palette)
        if needs.count == 0 {
          Image(systemName: "checkmark.circle.fill")
            .font(.title)
            .foregroundColor(palette.good)
            .padding(.top, 4)
          Spacer(minLength: 0)
          Text(needs.empty).font(.subheadline.weight(.semibold)).foregroundColor(palette.text).lineLimit(2)
        } else {
          Text("\(needs.count)")
            .font(.system(size: 40, weight: .bold, design: .rounded))
            .foregroundColor(needs.urgent > 0 ? palette.danger : palette.text)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
          Spacer(minLength: 0)
          if let first = needs.rows.first {
            Text(first.title)
              .font(.subheadline.weight(.semibold))
              .foregroundColor(palette.text)
              .lineLimit(2)
              .privacySensitive(names)
          }
        }
      }
    default:
      let shown = family == .systemLarge ? 6 : 3
      VStack(alignment: .leading, spacing: family == .systemLarge ? 10 : 8) {
        Header(title: needs.title, trailing: needs.count > 0 ? needs.countWords : nil, palette: palette)
        if family == .systemLarge { BusinessLine(data: data, palette: palette) }
        if needs.count == 0 {
          Label(needs.empty, systemImage: "checkmark.circle.fill")
            .font(.subheadline.weight(.semibold))
            .foregroundColor(palette.text)
        } else {
          Rows(list: needs, shown: shown, names: names, palette: palette, spacing: family == .systemLarge ? 10 : 8)
        }
        Spacer(minLength: 0)
        if family == .systemLarge { UpdatedLine(data: data, palette: palette) }
      }
    }
  }
}

// MARK: - Quick actions

struct ActionButton: View {
  let action: WAction
  let palette: WPalette
  var compact = false

  var body: some View {
    Tap(url: action.url) {
      VStack(spacing: 6) {
        Image(systemName: actionSymbol(action.key))
          .font(.system(size: compact ? 16 : 20, weight: .semibold))
          .foregroundColor(action.key == "ask" ? Color.white : palette.accentText)
          .frame(width: compact ? 38 : 46, height: compact ? 38 : 46)
          .background(Circle().fill(action.key == "ask" ? palette.accent : palette.accentSoft))
        Text(action.label)
          .font(.caption2.weight(.medium))
          .foregroundColor(palette.text)
          .lineLimit(1)
          .minimumScaleFactor(0.8)
      }
      .frame(maxWidth: .infinity)
    }
  }
}

struct QuickView: View {
  let entry: HfosEntry

  var body: some View {
    Shell(entry: entry) { data, face, palette in
      QuickContent(data: data, face: face, palette: palette)
    }
    .widgetURL(URL(string: appUrl))
  }
}

struct QuickContent: View {
  let data: WidgetsData
  let face: WFace
  let palette: WPalette

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Header(title: face.quick.title, trailing: data.showBusiness ? data.business.name : nil, palette: palette)
      Spacer(minLength: 0)
      HStack(alignment: .top, spacing: 4) {
        ForEach(face.quick.actions) { action in
          ActionButton(action: action, palette: palette)
        }
      }
      Spacer(minLength: 0)
    }
  }
}

// MARK: - Money

struct MoneyView: View {
  let entry: HfosEntry

  var body: some View {
    Shell(entry: entry) { data, face, palette in
      MoneyContent(data: data, face: face, palette: palette)
    }
    .widgetURL(tapUrl(entry) { _, face in face.money.url })
  }
}

struct MoneyContent: View {
  let data: WidgetsData
  let face: WFace
  let palette: WPalette
  @Environment(\.widgetFamily) private var family

  var body: some View {
    let money = face.money
    VStack(alignment: .leading, spacing: 8) {
      Header(
        title: money.title,
        trailing: family == .systemMedium && data.showBusiness ? data.business.name : nil,
        palette: palette
      )
      if !money.allowed {
        Text(money.note ?? "").font(.footnote).foregroundColor(palette.text2)
        Spacer(minLength: 0)
      } else if family == .systemSmall {
        if let owed = money.figures.first {
          FigureView(figure: owed, big: true, palette: palette)
        }
        if money.figures.count > 1 {
          FigureView(figure: money.figures[1], palette: palette)
        }
        Spacer(minLength: 0)
      } else {
        let columns = [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)]
        LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
          ForEach(money.figures) { figure in
            FigureView(figure: figure, palette: palette)
          }
        }
        Spacer(minLength: 0)
        if let note = money.note {
          Text(note).font(.caption).foregroundColor(palette.text2).lineLimit(1)
        }
      }
    }
  }
}

// MARK: - Social Outreach

struct OutreachView: View {
  let entry: HfosEntry

  var body: some View {
    Shell(entry: entry) { data, face, palette in
      OutreachContent(data: data, face: face, palette: palette)
    }
    .widgetURL(tapUrl(entry) { data, face in face.addons["outreach"]?.url ?? data.url })
  }
}

struct OutreachContent: View {
  let data: WidgetsData
  let face: WFace
  let palette: WPalette
  @Environment(\.widgetFamily) private var family

  var body: some View {
    if let addon = face.addons["outreach"] {
      VStack(alignment: .leading, spacing: 8) {
        Header(title: addon.title, trailing: nil, palette: palette)
        if !addon.on {
          Text(addon.note ?? "").font(.footnote).foregroundColor(palette.text2)
          Spacer(minLength: 0)
        } else if family == .systemSmall {
          if let goal = addon.figures.first {
            FigureView(figure: goal, big: true, palette: palette)
          }
          Spacer(minLength: 0)
          if let note = addon.note {
            Text(note).font(.caption).foregroundColor(palette.text2).lineLimit(2)
          }
        } else {
          HStack(alignment: .top, spacing: 12) {
            ForEach(addon.figures) { figure in
              FigureView(figure: figure, big: true, palette: palette)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
          }
          Spacer(minLength: 0)
          if let note = addon.note {
            Text(note).font(.caption).foregroundColor(palette.text2).lineLimit(1)
          }
        }
      }
    } else {
      EmptyNote(text: EmptyWords.signedOut, palette: palette)
    }
  }
}

// MARK: - Ask HandsFreeOS

struct AskView: View {
  let entry: HfosEntry
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var scheme

  private var url: URL? { tapUrl(entry) { _, face in face.ask.url } }

  var body: some View {
    if family == .accessoryCircular {
      ZStack {
        AccessoryWidgetBackground()
        Image(systemName: "mic.fill").font(.system(size: 22, weight: .semibold))
      }
      .widgetURL(url)
      .accessoryBackground()
    } else {
      let palette = WPalette(dark: scheme == .dark)
      let ask: WAsk? = {
        if case .ready(_, let face, redact: _) = entry.state { return face.ask }
        return nil
      }()
      VStack(alignment: .leading, spacing: 4) {
        Image(systemName: "mic.fill")
          .font(.system(size: 24, weight: .semibold))
          .foregroundColor(palette.accent)
          .frame(width: 52, height: 52)
          .background(Circle().fill(Color.white))
        Spacer(minLength: 0)
        Text(ask?.title ?? Gallery.ask.name)
          .font(.subheadline.weight(.bold))
          .foregroundColor(.white)
          .lineLimit(2)
        if let hint = ask?.hint {
          Text(hint).font(.caption).foregroundColor(Color.white.opacity(0.85)).lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .widgetBackground(palette.accent)
      .widgetURL(url)
    }
  }
}

// MARK: - Lock screen

struct LockView: View {
  let entry: HfosEntry
  @Environment(\.widgetFamily) private var family

  private var lock: WLock? {
    if case .ready(_, let face, redact: _) = entry.state { return face.lock }
    return nil
  }

  private var url: URL? { tapUrl(entry) { data, _ in data.url } }

  var body: some View {
    Group {
      switch family {
      case .accessoryInline:
        Label(lock?.line ?? Gallery.lock.name, systemImage: "calendar")
      case .accessoryCircular:
        ZStack {
          AccessoryWidgetBackground()
          VStack(spacing: 0) {
            Image(systemName: "tray.full").font(.system(size: 12, weight: .semibold))
            Text("\(lock?.needs ?? 0)").font(.system(size: 20, weight: .bold, design: .rounded))
              .lineLimit(1)
              .minimumScaleFactor(0.6)
          }
        }
      default:
        VStack(alignment: .leading, spacing: 1) {
          if let lock {
            if let time = lock.time, let what = lock.what {
              Text(time).font(.headline).lineLimit(1).widgetAccentable()
              Text(what).font(.body).lineLimit(1)
            } else {
              Text(lock.line).font(.headline).lineLimit(2)
            }
            Text(lock.needsWords).font(.caption).lineLimit(1).foregroundStyle(.secondary)
          } else {
            Text(Gallery.lock.name).font(.headline)
            Text(entry.isLocked ? EmptyWords.locked : EmptyWords.signedOut).font(.caption).lineLimit(2)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .widgetURL(url)
    .accessoryBackground()
  }
}

extension HfosEntry {
  var isLocked: Bool {
    if case .locked = state { return true }
    return false
  }
}

// MARK: - My day

struct MyDayView: View {
  let entry: HfosEntry

  var body: some View {
    Shell(entry: entry) { data, face, palette in
      MyDayContent(data: data, face: face, palette: palette)
    }
    .widgetURL(tapUrl(entry) { data, _ in data.url })
  }
}

struct MyDayContent: View {
  let data: WidgetsData
  let face: WFace
  let palette: WPalette

  var body: some View {
    let names = !data.hideNames
    VStack(alignment: .leading, spacing: 10) {
      Header(title: Gallery.myday.name, trailing: face.today.date, palette: palette)
      BusinessLine(data: data, palette: palette)
      Tap(url: face.today.url) {
        Header(title: face.today.title, trailing: face.today.countWords, palette: palette)
      }
      Rows(list: face.today, shown: 3, names: names, palette: palette)
      Divider()
      Tap(url: face.needs.url) {
        Header(title: face.needs.title, trailing: face.needs.count > 0 ? face.needs.countWords : nil, palette: palette)
      }
      if face.needs.count == 0 {
        Text(face.needs.empty).font(.subheadline).foregroundColor(palette.text2)
      } else {
        Rows(list: face.needs, shown: 1, names: names, palette: palette)
      }
      Spacer(minLength: 0)
      HStack(alignment: .top, spacing: 4) {
        ForEach(face.quick.actions) { action in
          ActionButton(action: action, palette: palette, compact: true)
        }
      }
    }
  }
}
