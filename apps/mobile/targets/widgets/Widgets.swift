import SwiftUI
import WidgetKit

/// The home-screen and lock-screen widgets (docs/phone-widgets.md). Each reads the same copy; core worked out what it
/// says for every moment ahead, so the timeline is those moments and nothing is decided here.

struct HfosEntry: TimelineEntry {
  let date: Date
  let state: EntryState
}

enum EntryState {
  case missing
  case locked
  /// `redact` for WidgetKit's placeholder, which shows the shape with grey bars.
  case ready(WidgetsData, WFace, redact: Bool)
}

extension HfosEntry {
  static func sample(at date: Date, redact: Bool) -> HfosEntry {
    guard let data = Sample.data else { return HfosEntry(date: date, state: .missing) }
    return HfosEntry(date: date, state: .ready(data, data.moments[0].face, redact: redact))
  }
}

struct HfosProvider: TimelineProvider {
  func placeholder(in context: Context) -> HfosEntry {
    .sample(at: Date(), redact: true)
  }

  func getSnapshot(in context: Context, completion: @escaping (HfosEntry) -> Void) {
    let now = Date()
    switch WidgetsStore.load() {
    case .ready(let data):
      completion(HfosEntry(date: now, state: .ready(data, data.face(at: now), redact: false)))
    case .locked:
      completion(context.isPreview ? .sample(at: now, redact: false) : HfosEntry(date: now, state: .locked))
    case .missing:
      completion(context.isPreview ? .sample(at: now, redact: false) : HfosEntry(date: now, state: .missing))
    }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<HfosEntry>) -> Void) {
    let now = Date()
    switch WidgetsStore.load() {
    case .missing:
      // The app asks for a reload each time it writes the copy.
      completion(Timeline(entries: [HfosEntry(date: now, state: .missing)], policy: .never))
    case .locked:
      // Look again once the phone has likely been unlocked.
      completion(
        Timeline(
          entries: [HfosEntry(date: now, state: .locked)],
          policy: .after(now.addingTimeInterval(15 * 60))
        )
      )
    case .ready(let data):
      let dated: [(Date, WFace)] = data.moments.compactMap { moment in
        guard let at = WDate.parse(moment.at) else { return nil }
        return (at, moment.face)
      }
      var entries = [HfosEntry(date: now, state: .ready(data, data.face(at: now), redact: false))]
      for (at, face) in dated where at > now {
        entries.append(HfosEntry(date: at, state: .ready(data, face, redact: false)))
      }
      // After the last moment (the end of tomorrow) nothing more is known until the app opens: look again hourly.
      let policy: TimelineReloadPolicy =
        entries.count > 1 ? .atEnd : .after(now.addingTimeInterval(60 * 60))
      completion(Timeline(entries: entries, policy: policy))
    }
  }
}

@main
struct HfosWidgets: WidgetBundle {
  var body: some Widget {
    MyDayWidget()
    TodayWidget()
    NeedsWidget()
    QuickWidget()
    MoneyWidget()
    OutreachWidget()
    AskWidget()
    LockWidget()
  }
}

struct MyDayWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "HfosMyDay", provider: HfosProvider()) { entry in
      MyDayView(entry: entry)
    }
    .configurationDisplayName(Gallery.myday.name)
    .description(Gallery.myday.description)
    .supportedFamilies([.systemLarge])
  }
}

struct TodayWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "HfosToday", provider: HfosProvider()) { entry in
      TodayView(entry: entry)
    }
    .configurationDisplayName(Gallery.today.name)
    .description(Gallery.today.description)
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}

struct NeedsWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "HfosNeeds", provider: HfosProvider()) { entry in
      NeedsView(entry: entry)
    }
    .configurationDisplayName(Gallery.needs.name)
    .description(Gallery.needs.description)
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}

struct QuickWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "HfosQuick", provider: HfosProvider()) { entry in
      QuickView(entry: entry)
    }
    .configurationDisplayName(Gallery.quick.name)
    .description(Gallery.quick.description)
    .supportedFamilies([.systemMedium])
  }
}

struct MoneyWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "HfosMoney", provider: HfosProvider()) { entry in
      MoneyView(entry: entry)
    }
    .configurationDisplayName(Gallery.money.name)
    .description(Gallery.money.description)
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

struct OutreachWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "HfosOutreach", provider: HfosProvider()) { entry in
      OutreachView(entry: entry)
    }
    .configurationDisplayName(Gallery.outreach.name)
    .description(Gallery.outreach.description)
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

struct AskWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "HfosAsk", provider: HfosProvider()) { entry in
      AskView(entry: entry)
    }
    .configurationDisplayName(Gallery.ask.name)
    .description(Gallery.ask.description)
    .supportedFamilies([.systemSmall, .accessoryCircular])
  }
}

struct LockWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "HfosLock", provider: HfosProvider()) { entry in
      LockView(entry: entry)
    }
    .configurationDisplayName(Gallery.lock.name)
    .description(Gallery.lock.description)
    .supportedFamilies([.accessoryRectangular, .accessoryCircular, .accessoryInline])
  }
}
