# HandsFreeOS widgets on the phone's home screen

The owner's ask of 27 November 2026: "i want to create a widget for the phone app. maybe a few different ones for
different purposes if possible."

The owner's picks, 28 November 2026:

- **Which widgets:** all six ideas, plus the all-in-one: **My day**, **Today**, **Needs you**, **Quick actions**,
  **Money**, **Social Outreach** and **Ask HandsFreeOS**, and an iPhone **lock-screen** widget.
- **Names:** customers' names show, with a **Hide names on widgets** switch in the app's settings. The lock screen never
  shows a name.
- **Release:** with the HandsFreeOS keyboard, in the 1.0.1 store release (docs/phone-keyboard.md). Both add native
  targets and share one App Group, so they go to App Review once.
- **Typing and sending:** not on a widget (neither phone allows typing in one). A tap opens the app at that place;
  answering a text from its notification already works.

## What a person sees

**Adding one** is the phone's own: touch and hold the home screen, then **+** (or Edit → Add Widget) on an iPhone, or
**Widgets** on Android, and find HandsFreeOS. More → Settings → **Home-screen widgets** gives the same steps.

| Widget              | Sizes                                     | What it shows                                                                                                    | A tap opens                                   |
| ------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **My day**          | iPhone large; Android 4×4                 | Today's next appointments, the top thing that needs you, and Quick actions' four buttons                         | each row and button its place; elsewhere Home |
| **Today**           | small, medium, large; Android 2×2 and up  | The day's appointments still to come ("Now" for one going on), "+N more", and the tasks due ("1 overdue")        | each appointment; Calendar; Tasks             |
| **Needs you**       | small, medium, large; Android 2×2 and up  | What Home ranks first, urgent marked, and how many in all; "You're all caught up" with none                      | each item on Home (`?item=`); Home            |
| **Quick actions**   | iPhone medium; Android 4×1                | Add contact, Snap receipt, New invoice (each only for someone who may), filled with Calendar and Tasks, then Ask | its screen; New invoice opens the web         |
| **Money**           | small, medium; Android 2×2                | Owed, late, in today, last 7 days, and "5 invoices waiting · 1 is late", for whoever manages money               | Money                                         |
| **Social Outreach** | small, medium; Android 2×2                | First messages today against the goal on every network worked, replies to OK, messages to OK                     | Social Outreach's Needs you                   |
| **Ask HandsFreeOS** | small and lock screen; Android 1×1 and up | A mic                                                                                                            | the Assistant, talking out loud at once       |
| **Lock screen**     | iPhone: rectangular, circular, inline     | The next appointment as what it is ("2:30 PM · Duct cleaning") and how many things need you; never a name        | Home                                          |

- **Lists scroll on Android,** through the eight rows the copy holds. An iPhone widget never scrolls, so it shows 1, 3
  or 6 rows with "+N more".
- **Someone who can't use something** sees why instead: Money says "Only people who manage money see this…", and Social
  Outreach says it isn't on for them in that business and to ask an owner.
- **Several businesses:** the widgets show the business open in the app, named on the larger ones.
- **Hide names on widgets** (each person's own, on that phone): an appointment shows its service, its calendar or
  "Appointment" and the town; an item shows its kind ("Hot lead"). iOS also hides names where it hides private things
  (StandBy, a locked phone), because they're marked private.

**When they update:** while the app is open, as things change, and each time it opens. The copy holds every moment from
now to the end of tomorrow, so appointments move along without the app: an iPhone switches at each start and end, and
Android redraws at least every 30 minutes. A new lead or message shows the next time the app opens. **Update now** on
the settings screen builds it again at once.

## How it works

- **Core decides everything** (`packages/core/src/widgets`). `buildWidgetsData` takes what the phone has and returns
  `WidgetsData`: for each **moment** (now, each appointment's start and end ahead, the next midnight), every widget's
  face in words, links included. A widget only picks the latest moment that has begun (`widgetFaceAt`) and lays the
  words out. Its words are `WIDGET_WORDS`, the gallery's `WIDGET_GALLERY`, the screen's `WIDGET_SCREEN_WORDS`.
- **An add-on's widget** is the add-on's own: core takes its `AddonWidgetFacts` (figures, a note, the page to open).
  Social Outreach's are worked out by `outreachWidgetFacts` (`packages/core/src/addons/outreach/widget.ts`) and gathered
  on the phone by `OutreachWidgetFacts`, the registry's `WidgetFacts` slot (`apps/mobile/src/addons/registry.ts`).
- **The app keeps the copy fresh** (`apps/mobile/src/widgets/keep-fresh.tsx`, mounted in the business's layout beside
  the keyboard's):
  - today's and tomorrow's appointments (everyone's, as Calendar shows by default), the person's open tasks, Home's
    list (`useHome`, the default Mine or Everyone), the money figures, and each add-on's facts, all from the phone's copy
    except Social Outreach's goal (`outreach.today` for each network, when the business opens and on Update now);
  - rebuilt as those change, a moment after they settle, and when the app comes back to the front;
  - saved only when it says something new (`widgetsKey`), or every 15 minutes so "Updated" stays near the truth, since
    an iPhone limits how often a widget reloads in the background;
  - not while viewing as a teammate: the widgets are the signed-in person's own.
- **Where the copy lives:** `modules/hfos-shared` under the key `widgets` (the keyboard's store): a file in the App
  Group on iPhone, the app's own preferences on Android. Saving asks the widgets to draw again (`redrawWidgets`).
- **Signing out forgets it** (`watchWidgetsOwner`, started in `src/lib/app-start.ts`), and the widgets go back to "Open
  HandsFreeOS to see your day here."
- **iPhone** (`apps/mobile/targets/widgets`, SwiftUI and WidgetKit, built by `@bacons/apple-targets` at prebuild): one
  timeline for every widget, an entry per moment. Before the phone's first unlock after a restart iOS keeps the file
  shut, so the widgets say "Unlock your phone to see HandsFreeOS." and look again in 15 minutes. The widget gallery shows
  a made-up, nameless sample (`Sample` in `Shared.swift`) to anyone not signed in yet.
- **Android** (`apps/mobile/src/widgets/android.tsx`, `react-native-android-widget`): plain functions that return the
  library's widget elements, light and dark. Android starts the app with no screen to draw one when it's added, resized
  and every 30 minutes (`android-task.ts`, registered at the top of `index.ts`), and the app redraws them all whenever it
  saves.
- **Links** are the app's own `handsfreeos://app/w/<business>/…`, read by the route map like a notification's: Add
  contact (`customers/new`), Snap receipt (`money/expenses?add=1`, which opens Add expense), Ask (`assistant?talk=1`,
  which starts talking out loud once the Assistant can listen; never over its consent step).

### The pieces

| Piece                                   | Where                                                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| The data and its words                  | `packages/core/src/widgets/data.ts`, `words.ts`; tests in `packages/core/test/widgets.test.ts`                             |
| Social Outreach's figures               | `packages/core/src/addons/outreach/widget.ts`; on the phone `apps/mobile/src/addons/outreach/widget.tsx`                   |
| Keeping it fresh, saving it, the switch | `apps/mobile/src/widgets/` (`keep-fresh.tsx`, `store.ts`); tests in `src/widgets/__tests__`                                |
| The Home-screen widgets screen          | `apps/mobile/src/app/app/w/[workspaceId]/(tabs)/(more)/settings/widgets.tsx`                                               |
| The iPhone widgets                      | `apps/mobile/targets/widgets` (`WidgetsData.swift`, `Widgets.swift`, `Views.swift`, `Shared.swift`)                        |
| The Android widgets                     | `apps/mobile/src/widgets/android.tsx`, `android-task.ts`; declared in `app.json` under `react-native-android-widget`       |
| Settings search, the Assistant          | `phone.widgets` in `settings/catalog.ts`; `SETTINGS_NEVER` in `assistant/coverage.ts`; the widgets line in `places-map.ts` |

## Rules worth knowing before changing anything

- **The owner's picks above are settled.** Ask before changing which widgets there are, whether names show by default,
  or shipping them apart from the keyboard.
- **Core decides; the widgets draw.** A new figure, row, word or link goes in core. Swift or Android code that starts
  to decide something is code written three times.
- **The gallery's names live in three places:** `WIDGET_GALLERY`, `Gallery` in `targets/widgets/Shared.swift` and the
  labels in `app.json`. A phone test (`src/widgets/__tests__/native.test.ts`) checks they match, and that the sample in
  `Shared.swift` has the copy's shape.
- **Changing the copy's shape means `WIDGETS_DATA_VERSION` + 1,** and the same number in `WidgetsData.swift`. The app
  and its widgets ship in one build, so they always agree; the version is there so a stale file reads as nothing rather
  than as nonsense. Adding a field the Swift doesn't read needs no bump; renaming or removing one does.
- **Never put a sign-in or anything beyond what a widget shows in the copy.** It sits outside the app's encrypted copy
  of the business, readable by the widgets. The lock screen's part never names anyone.
- **A widget never sends anything,** and has no network code. A tap only opens the app.
- **The App Group is shared with the keyboard.** Keys are theirs or ours, never both: `widgets*` here, `keyboard*`
  there.
- **Keep it small** (`WIDGET_LIMITS`: 8 rows, 40 moments, 3 figures for an add-on). WidgetKit gives a widget little
  memory and closes one that takes more.
- **An add-on's widget goes through the registry,** never into core: its own facts, its own words, its `WidgetFacts`
  keeper. Core only knows `AddonWidgetFacts`.

## Releasing it

Native code, so it ships in a store build, never an over-the-air update, with the keyboard as **1.0.1**. The steps
are docs/phone-keyboard.md's "Releasing it": the one `eas credentials` run sets up `com.gobizhelp.handsfreeos.widgets`
with the App Group too. Before App Review, on a TestFlight build on a real iPhone: add each widget, check a tap opens
the right place, the lock-screen widget shows no name, Hide names works, and signing out empties them. On Android,
check the same from an internal testing build, and that a list scrolls.

## Not yet

- **New leads and messages while the app is closed.** A push could refresh the copy in the background (a silent push on
  iPhone, a data push on Android); the widgets wait for the app to open for now.
- **Picking a business for each widget** when the person has several. They follow the business open in the app.
- **Preview pictures in Android's widget list.** It shows the app's icon until they're made.
- **Acting from a widget** (an interactive Done or OK button, iOS 17's App Intents). Every tap opens the app.
- **Android lock-screen widgets** (Android 16 and some tablets).
