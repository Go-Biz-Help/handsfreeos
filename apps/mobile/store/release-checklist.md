# From here to a build on a phone

Everything in this folder was done without a developer account, a phone, or a build. What is left needs one of those.
In order, because most steps need the one before it.

## What Chris owes, and nothing can start without

1. **An Apple Developer Program membership** for **Go Biz Help LLC**, $99/year. The Apple Team ID is already committed
   as `8246H5FJ42` (`apps/web/src/lib/app-links.ts`, which the app-site-association file serves), so the membership
   must be that team — a personal team would break universal links and the push key.
2. **A Google Play Developer account** for Go Biz Help, $25 once, with identity verification. Verification has taken
   days before now, so start it first.
3. **An Expo account and organization** for Go Biz Help, and an **EAS Starter plan** ($19/month) for builds and
   over-the-air updates. The plan's decision.
4. **The Apple ID of the developer account** → `eas.json` → `submit.production.ios.appleId`. Left as
   `APPLE_ID_OF_THE_DEVELOPER_ACCOUNT_GOES_HERE`.
5. **The App Store Connect app record**, which gives an **ASC App ID** → `eas.json` →
   `submit.production.ios.ascAppId`. Left as `ASC_APP_ID_GOES_HERE`.
6. **A Play Console app record** for `com.gobizhelp.handsfreeos`, and a **service-account key** for the Google Play
   Android Developer API, saved at `secrets/play-service-account.json`. That folder is git-ignored; the key must never
   be committed.
7. **The EAS project id** → `apps/mobile/app.json` → `expo.extra.eas.projectId`, which is empty on purpose. `eas init`
   in `apps/mobile` prints it; paste it in by hand, because `app.config.ts` means `eas init` can't write it. Without
   it, a build registers no push token and Settings → Notifications says "Not in this build".
8. **`expo.owner`** in `app.json`, once the Expo organization's account name exists. Not set, so that nobody guesses it.
9. **The public website, deployed.** The three pages each store asks for by URL are built, in `apps/site`, but they
   are not live until that second Vercel project is deployed on `handsfreeos.com` — Stage 0 of the go-live checklist
   in `docs/operations.md`. They are `https://handsfreeos.com/privacy` (which has to keep matching
   [`privacy-app-store.md`](privacy-app-store.md) and [`privacy-play.md`](privacy-play.md)),
   `https://handsfreeos.com/support`, and `https://handsfreeos.com/app` for the marketing URL.
   (`https://app.handsfreeos.com/delete-account` already exists and covers both stores' deletion requirement.)
   The governing state, the mailing address and the legal review are all done; what is left is the deploy itself.
10. **A password for the demo business**, given to the seed as `HFOS_DEMO_PASSWORD` and typed into both consoles'
    review sign-in fields. See [`reviewer-demo.md`](reviewer-demo.md).
11. **A real mailbox at `app-review@handsfreeos.com`**, and a phone number for the demo business (a dollar or two a
    month) so the reviewer's inbox isn't empty.
12. **Two confirmations that aren't technical:** the export-compliance answer (`ITSAppUsesNonExemptEncryption: false`,
    reasoning in [`listing-app-store.md`](listing-app-store.md)), and how Apple's messaging/moderation question should
    be answered ([`age-rating.md`](age-rating.md)).

## Then, in this order

13. **`eas login` and `eas init`** in `apps/mobile`, under the Go Biz Help organization. Paste the project id into
    `app.json`.
14. **`eas update:configure`**, which adds `updates.url` to the config. The channels are already in `eas.json`:
    `development`, `preview`, `production`, and `runtimeVersion` is `{ "policy": "fingerprint" }`, so an update only
    reaches builds whose native side matches it — the right policy here, because this app has native modules of its
    own.
15. **`eas credentials`** for both platforms: let EAS make the iOS distribution certificate, the provisioning profile
    and the **push key** (in the Go Biz Help team, never a personal one), and the Android upload keystore. EAS keeps
    all of them; none go in this repository.
16. **A preview build on both phones** (`eas build --profile preview`) before anything goes to a store, because it is
    the first build with the new icons, the blocked permissions and the privacy manifest in it. Check, on the phone:
    the icon on the home screen in light, dark and tinted; the splash in light and dark; Android's themed icon with a
    coloured wallpaper; that the app still signs in, syncs and sends.
17. **Check the merged manifest of that build** against [`permissions.md`](permissions.md). Two things especially:
    `SYSTEM_ALERT_WINDOW` must be gone, and `usesCleartextTraffic` must be absent (it is only for the Maestro test
    builds).
18. **Retake the store screenshots** — [`screenshots.md`](screenshots.md) says which six, at which sizes, and from
    which existing shot. This is the only remaining thing that needs a simulator.
19. **Seed the demo business** into the hosted project ([`reviewer-demo.md`](reviewer-demo.md)), and sign into it from
    a real build on both phones with the password a reviewer will type.
20. **Fill both consoles** from the files here: listing text, icons, feature graphic, screenshots, privacy answers,
    age rating, app access, data deletion.
21. **`eas build --profile production` for both platforms**, then `eas submit`. iOS goes to TestFlight; Android goes to
    the internal testing track as a draft (`eas.json` says so). Neither is public.
22. **Install from TestFlight and Play internal testing**, on both phones, and run a real day through the app.

**Publishing waits for Chris's go-live.** TestFlight and internal testing are the end of this step; promotion to the
App Store and to a Play production release is a separate decision.

## Two things worth knowing before the first build

- **`eas.json` says `requireCommit: true`**, so EAS refuses to build a dirty tree. That is on purpose: a store build
  should be a commit that can be found again. It also means this step's own changes have to be committed first.
- **`appVersionSource` is `remote`**, so EAS keeps the build number and raises it itself on `preview` and `production`
  (`autoIncrement`). `version` in `app.json` (`1.0.0`) stays the one Chris edits — it is what a customer sees, and
  `runtimeVersion`'s fingerprint policy doesn't depend on it. `ios.buildNumber` and `android.versionCode` in `app.json`
  are only there so a local `expo run:` build has sane values; EAS ignores them.
