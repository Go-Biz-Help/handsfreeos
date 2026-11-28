# The HandsFreeOS keyboard on the phone

The owner's ask of 27 November 2026: "add a custom keyboard to the phone apps that will allow users to easily access
snippets and calendar links and form links etc."

The owner's picks, the same day:

- **What it holds:** the business's templates, booking links and form links, plus its Google review link and website.
- **A first name in a template:** "Ask me for the name". A small box asks for it; Skip types the template's own
  default, or "there".
- **Release:** together with the home-screen widgets, in the 1.0.1 store release. Both add native targets and share
  one App Group, so they go to App Review once.

## What a person does

**Turning it on** is More → Settings → **Phone keyboard**. The screen says whether it's on, gives the steps and has
the button for them:

- **iPhone:** Open Settings → Keyboards → turn on HandsFreeOS → turn on **Allow Full Access**. Then open the keyboard
  once in any app (hold or tap the globe). The status says "On, with Full Access" once the keyboard has opened that
  way, because iOS doesn't let an app ask whether one of its keyboards is on.
- **Android:** **Turn it on** opens the phone's list of keyboards; then **Switch keyboard** shows the phone's picker.

**Using it,** in any app:

- The top row has **Templates**, **Links**, the business's name (when the person has more than one business on this
  phone) and **ABC** to go back to the letters.
- **Templates** lists the business's text and email templates, most used first as in the inbox, each with its folder
  and a one-line preview. Tapping one types it. A template with `{{person.first_name}}` asks "Their first name" first, in a box above the letters; **Add**
  types it with the name, **Skip** with the default.
- **Links** lists the booking pages, the live forms (and surveys and quizzes), the review link and the website. A link
  typed after a word gets a space before it.
- The letters work like the phone's own: shift once, double tap for caps lock, a capital after a full stop, two spaces
  for a full stop, delete held down repeats, and the return key says what the field wants (send, search, go).
- Without Full Access on an iPhone, or before anyone has signed in to the app, the letters still work and the panels
  say what to do instead.

**What's on it** is on the same settings screen: "12 templates and 5 links from Lone Star HVAC", when it was last
updated, and **Update now**.

## How it works

- **Core builds everything** (`packages/core/src/keyboard`). `buildKeyboardBusiness` takes the business's templates
  and details and returns what the keyboard shows. Each template is already split into parts: words, with the
  business's own details filled in by core's `render` (its name, phone, email, website, main booking link, review
  link), and first-name parts to ask for. The native keyboards only join parts; they never parse a placeholder.
- **Anything else a template needs** (a lead's title, an appointment's time) stays as typed, and the keyboard shows
  "Fill in {{lead.title}} before you send it." for a few seconds after it goes in.
- **The keyboard's words come from core too** (`KEYBOARD_PANEL_WORDS`, inside the data). The native code has its own
  words only for when it can't read the data: no Full Access, nobody signed in, or data newer than the keyboard.
- **The app keeps the copy fresh** (`apps/mobile/src/keyboard/keep-fresh.tsx`, mounted in the business's layout):
  - links and business details as the phone's synced copy changes;
  - templates from `template.list` when the business opens, when the app comes back after 5 minutes, and on Update
    now.
  - With no signal, the templates the keyboard already has stay.
  - Someone without `inbox.use` gets links only, and the screen says why.
  - Not while viewing as a teammate: the keyboard is the signed-in person's own.
- **Links use the business's own web address** when it's verified with its certificate ready, else
  `app.handsfreeos.com`, as forms' share links do. Booking pages are the calendars customers can book (active, public,
  on an enabled booking site), oldest first, like `{{links.booking}}`. Live polls are left out: they're asked in a
  video call, never sent.
- **Where the copy lives** (`apps/mobile/modules/hfos-shared`, one JSON string per key):
  - iPhone: `<App Group>/hfos-shared/<key>.json` in `group.com.gobizhelp.handsfreeos`, with the folder kept out of
    backups. Only the keyboard and, later, the widgets read it.
  - Android: the app's own `hfos_shared` preferences, which the keyboard reads directly because it runs inside the app
    there.
- **Several businesses:** the copy holds each business the person opened on this phone, up to 10, the open one first.
  A business they're no longer in is dropped at the next save. Picking another business on the keyboard lasts while
  the app still has the same business open; opening another business in the app moves the keyboard to it.
- **Signing out forgets it** (`watchKeyboardOwner`, started in `src/lib/app-start.ts`), so whoever signs in next starts with
  nothing.

### The pieces

| Piece                                | Where                                                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| The data and its words               | `packages/core/src/keyboard/data.ts`, `words.ts`; tests in `packages/core/test/keyboard.test.ts`                             |
| Saving it for the keyboard           | `apps/mobile/modules/hfos-shared` (Swift and Kotlin)                                                                         |
| Keeping it fresh, the screen's state | `apps/mobile/src/keyboard/` (`keep-fresh.tsx`, `store.ts`, `device.ts`); tests in `src/keyboard/__tests__`                   |
| The Phone keyboard screen            | `apps/mobile/src/app/app/w/[workspaceId]/(tabs)/(more)/settings/keyboard.tsx`                                                |
| The iPhone keyboard                  | `apps/mobile/targets/keyboard` (SwiftUI), built by `@bacons/apple-targets` at prebuild                                       |
| The Android keyboard                 | `apps/mobile/modules/hfos-keyboard` (an `InputMethodService`, plain Android views, no Compose)                               |
| Settings search, the Assistant       | `phone.keyboard` in `settings/catalog.ts`; `SETTINGS_NEVER` in `assistant/coverage.ts`; the keyboard line in `places-map.ts` |

### The keys it uses

| Key                           | Holds                                                                      | Written by           |
| ----------------------------- | -------------------------------------------------------------------------- | -------------------- |
| `keyboard`                    | `KeyboardData`, version 1                                                  | the app              |
| `keyboard-seen`               | `{ at, fullAccess }`, each time the iPhone keyboard opens with Full Access | the iPhone keyboard  |
| `keyboard-pick` (Android)     | `"<business id>\|<app's open business id>"`                                | the Android keyboard |
| `hfos.keyboard.pick` (iPhone) | the same, in the keyboard's own `UserDefaults`                             | the iPhone keyboard  |

## Privacy and App Review

- **Full Access** is what lets an iPhone keyboard read the App Group, so the keyboard asks for it (`RequestsOpenAccess`
  in `targets/keyboard/Info.plist`). iOS then warns that the keyboard could send what you type. The screen says why
  it's safe here, and it's true: the keyboard has no network code, saves nothing typed, and writes only its
  `keyboard-seen` stamp.
- **Android** shows a similar warning when any keyboard is switched on. Same answer.
- **App Review 4.4.1** for keyboards: it must type letters, have a way to the next keyboard, work without Full Access,
  and not open other apps. All four hold: the letters are always there, the globe appears when iOS asks for one
  (`needsInputModeSwitchKey`), and without Full Access the letters work and the panel explains.
- **Store privacy answers don't change.** Nothing new leaves the phone: the templates and links already come from
  HandsFreeOS, and the keyboard sends nothing. Mention the keyboard in the App Review notes for 1.0.1, with the steps
  to turn it on.

## Releasing it

It's native code, so it ships in a store build, never an over-the-air update. With the widgets, as **1.0.1**.

1. **Apple Developer:** the App Group `group.com.gobizhelp.handsfreeos`, and two new bundle ids,
   `com.gobizhelp.handsfreeos.keyboard` and `com.gobizhelp.handsfreeos.widgets`, each with the App Group.
   `eas credentials` does this; it needs the owner's Apple sign-in, so it's run once on the owner's Mac, from
   `apps/mobile` on an up-to-date `main`:
   `npx --yes eas-cli@latest credentials --platform ios`. Pick the production profile, and let it set up each target.
2. **Prebuild adds the target.** `@bacons/apple-targets` writes it into the Xcode project and adds it to
   `extra.eas.build.experimental.ios.appExtensions`, so EAS signs it too. `ios.appleTeamId` in `app.json` must stay.
3. **Raise `version` to 1.0.1** in `app.json` in the same release.
4. **Before App Review,** install the TestFlight build and check, on a real iPhone: the keyboard appears in Settings,
   Full Access turns on, the templates and links show, a first name is asked for, and the globe and delete work.
   On Android, check the same from an internal testing build.

## Rules worth knowing before changing anything

- **The owner's picks above are settled.** Ask before changing what it holds, how a first name is asked for, or
  shipping it apart from the widgets.
- **Core decides; the keyboards draw.** A new kind of link, a new placeholder filled in or a new word goes in core.
  Native code that starts to decide something is code written twice.
- **Changing the data's shape means `KEYBOARD_DATA_VERSION` + 1.** A keyboard that finds a newer version says
  "Update HandsFreeOS" rather than guessing. Adding an optional field doesn't need it; renaming or removing one does.
- **Never put a customer's details or a sign-in in the copy.** It sits outside the app's encrypted copy of the
  business, readable by the keyboard. Templates, the business's own details and public links only.
- **The keyboard never sends anything,** and never keeps what's typed. No network code goes in either target.
- **The App Group is shared with the widgets.** Keys are theirs or ours, never both: `keyboard*` here, `widgets*` there.
- **Keep it small.** The limits (`KEYBOARD_LIMITS`: 200 templates of up to 4,000 characters, 80 links, 10 businesses)
  keep an iPhone keyboard well under its memory limit, which iOS enforces by closing it.

## Not yet

- Word suggestions and autocorrect, emoji, accents on a long press, and other languages' layouts. The globe switches
  to the phone's own keyboard for these.
- Filling in a customer's details. The keyboard doesn't know who the message is to.
- Searching templates on the keyboard. The list is most used first, so the usual ones are at the top.
