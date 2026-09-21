# From here to a build on a phone

The first build is on a phone: **iOS production build #2**, submitted to TestFlight on 2026-09-19 and working. What
follows is what that took, and what is still between here and both stores.

Checked against the repository and the hosted project on 2026-09-19. Anything marked "not checked" is something this
file can't see from here — a console, a mailbox, an account page.

## Done

| #   | What                       | How it is known                                                                                            |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | Apple Developer Program    | A signed production build reached TestFlight under team `8246H5FJ42`, which is the team the deep links use |
| 3   | Expo account and EAS plan  | Builds run under `@gobizhelp/handsfreeos`                                                                  |
| 4   | Apple ID                   | `eas.json` → `submit.production.ios.appleId` = `chris@gobizhelp.com`                                       |
| 5   | ASC App ID                 | `eas.json` → `submit.production.ios.ascAppId` = `6813606312`                                               |
| 7   | EAS project id             | `app.json` → `expo.extra.eas.projectId` = `22b0e923-de8b-4b67-9089-2c4bd440a956`                           |
| 8   | `expo.owner`               | `app.json` → `gobizhelp`                                                                                   |
| 9   | The public website         | `/privacy`, `/terms`, `/support`, `/app` and `app.handsfreeos.com/delete-account` all answer `200`         |
| 12a | Export compliance          | `ios.infoPlist.ITSAppUsesNonExemptEncryption: false` in `app.json`                                         |
| 13  | `eas login` and `eas init` | The project is linked and builds                                                                           |
| 15a | iOS signing                | Build #2 was signed and accepted by App Store Connect                                                      |
| 15b | Android keystore           | The Android preview build produced an installable APK                                                      |
| 18  | Store screenshots          | 16 files in `assets/screenshots/`: 8 iOS at 1320 × 2868, 8 Android at 1080 × 1920 — both stores' sizes     |
| 21a | iOS production build       | Build #2, `--auto-submit`, on TestFlight                                                                   |
| 22a | Installed from TestFlight  | Confirmed working on a phone                                                                               |

**Also done, and it was never in this list:** the five `EXPO_PUBLIC_` settings that tell a build where HandsFreeOS's
servers are. They live in EAS, not in this repository, and a build made without them opens on "This build isn't
connected" — which is exactly what the first TestFlight build did. See "The phone app: builds and the stores" in
`docs/operations.md`. Anyone adding a build profile or a new environment has to set them there too.

## Still open

In order, because some need the one before.

1. **Seed the demo business.** Not done: the hosted project has one user, and it isn't `app-review@handsfreeos.com`.
   Both stores refuse an app they can't sign into, so this blocks submission on both. Run the seed with
   `HFOS_DEMO_PASSWORD` set — see [`reviewer-demo.md`](reviewer-demo.md) — then sign into that account from a real
   build with the password a reviewer will type.
2. **A real mailbox at `app-review@handsfreeos.com`**, and a phone number for the demo business (a dollar or two a
   month) so the reviewer's inbox isn't empty. The password path never needs the inbox, but the address should be one
   that exists.
3. **A Google Play Developer account** for Go Biz Help, $25 once, with identity verification — not checked here.
   Verification has taken days before now, so start it before anything else on the Android side.
4. **A Play Console app record** for `com.gobizhelp.handsfreeos` — not checked here. A **service-account key** is
   **optional**. It only lets `eas submit` upload for you, and it now belongs in EAS rather than in this repository:
   `eas credentials --platform android` → **Google Service Account** → **Manage your Google Service Account Key for
   Play Store submissions**. A key on a Mac cannot be read by a build machine, so `eas.json` no longer names a path
   to one. With the key in EAS, set the GitHub repository variable `MOBILE_SUBMIT_ANDROID` to `true` and every
   release after that uploads itself. Google blocks key creation by default on new organisations
   (`iam.disableServiceAccountKeyCreation`), and turning that off needs an Organization Policy Administrator and does
   not always take effect quickly. Don't block a release on it: build the `.aab` with
   `eas build -p android --profile production` and upload it in Play Console under **Testing → Internal testing →
   Create new release** — which is also what the automated release does while `MOBILE_SUBMIT_ANDROID` is unset. A
   key, if one ever exists, belongs in EAS and must never be committed here.
5. ~~**`eas update:configure`.**~~ Done. `app.json` now has `expo.updates.url`, so over-the-air updates work: a
   JavaScript-only change reaches a build without a new one. The channels were already in `eas.json` (`development`,
   `preview`, `production`) and `runtimeVersion` is `{ "policy": "fingerprint" }`, so an update only reaches builds
   whose native side matches it — the right policy here, because this app has native modules of its own. Two things
   are still open for the automation that rides on this, both in "Phone Part 4" of `docs/operations.md`: the Expo
   GitHub App has to be linked to `gobizhelp/handsfreeos` with base directory `apps/mobile`, and GitHub needs an
   `EXPO_TOKEN` repository secret. Adding the `updates` key changed the fingerprint, so the next build on each
   platform is a fresh native build — once.
6. **The push key and Firebase**, if push is to work on real builds — not checked here. `eas credentials` sets both
   up; Expo Parts 4.2 and 4.3 in `docs/operations.md` say how. The worker already holds its `EXPO_ACCESS_TOKEN` and
   reports `"push":"expo"`, so the server half is ready and waiting.
7. **Check the merged manifest** of an Android build against [`permissions.md`](permissions.md) — not checked here.
   Two things especially: `SYSTEM_ALERT_WINDOW` must be gone, and `usesCleartextTraffic` must be absent (it is only
   for the Maestro test builds).
8. **Fill both consoles** from the files here: listing text, icons, feature graphic, screenshots, privacy answers,
   age rating, app access, data deletion. Not checked here.
9. **Answer Apple's messaging and moderation question** — see [`age-rating.md`](age-rating.md). Not a technical
   decision.
10. **`eas build -p android --profile production`**, then upload the `.aab` to the internal testing track as a draft.
    The iOS side of this is done.
11. **Install from Play internal testing** on an Android phone and run a real day through the app, as was done on
    iOS.

**Publishing still waits for Chris's go-live.** TestFlight and internal testing are the end of this list; promotion to
the App Store and to a Play production release is a separate decision, and neither is another upload — in App Store
Connect you submit a TestFlight build for review, and in Play Console you promote the internal testing release.

## Things worth knowing before a build

- **Build from `apps/mobile`, never the repository root.** From the root, `eas build` decides the root is an
  unconfigured Expo app, writes a stub `eas.json` and `app.json` there and asks for a bundle identifier before it
  fails. Delete both if it happens. Watch out for the `HandsFreeOS-build` worktree too, which sits on an old commit.
- **`eas.json` says `requireCommit: true`**, so EAS builds a commit, not your working tree. Uncommitted work is simply
  absent from the build. That is on purpose: a store build should be a commit that can be found again.
- **`appVersionSource` is `remote`**, so EAS keeps the build number and raises it itself on `preview` and `production`
  (`autoIncrement`). `version` in `app.json` (`1.0.0`) stays the one Chris edits — it is what a customer sees, and
  `runtimeVersion`'s fingerprint policy doesn't depend on it. `ios.buildNumber` and `android.versionCode` in
  `app.json` are only there so a local `expo run:` build has sane values; EAS ignores them.
- **Most builds no longer start from a keyboard.** A commit on `main` that CI passes makes EAS either build and
  submit or publish an over-the-air update, deciding per platform from the fingerprint; a push to any other branch
  publishes a preview update, and the `mobile-build` label on a pull request makes an installable build. "Phone Part
  4" in `docs/operations.md` has the whole arrangement. Everything below still applies to a build you start yourself.
- **Read the line that says which environment variables were loaded**, early in every build's output. It is the only
  place a build says what it is baking in, and a missing name there is a broken app twenty minutes later.
