# Every permission the app asks for

Not from reading `app.json`, which is only the wish: from reading what `expo prebuild` writes and what Gradle's
manifest merger actually produced.

- **iOS** — `ios/HandsFreeOS/Info.plist` after a prebuild.
- **Android** — `android/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml`
  after a release build, and `android/app/build/outputs/logs/manifest-merger-release-report.txt` for which library
  asked for each one.

Both folders are generated and not checked in, so redo it after changing `app.json` or `app.config.ts`:

```sh
cd apps/mobile
npx expo config --type prebuild --json | less   # what the config says
npx expo prebuild --no-install                  # what the native project says
```

## iOS: what the app explains to the person

Each string is in `app.json` — on the plugin that needs it, not in a list of its own — and says what the app does with
the thing, in the app's own voice.

| Key                                 | Words shown                                                               | Asked when                                                         | Set by                             |
| ----------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------- |
| `NSCameraUsageDescription`          | "HandsFreeOS uses the camera to take photos for your customers' records." | Taking a photo for a customer's record or a reply                  | `expo-image-picker` plugin         |
| `NSPhotoLibraryUsageDescription`    | "HandsFreeOS adds the photos you choose to your customers' records."      | Choosing a photo already on the phone                              | `expo-image-picker` plugin         |
| `NSFaceIDUsageDescription`          | "Face ID unlocks HandsFreeOS on this iPhone."                             | Unlocking the app, and confirming anything that reaches a customer | `expo-local-authentication` plugin |
| `NSPhotoLibraryAddUsageDescription` | "HandsFreeOS saves the QR codes you choose to save to your photos."       | Save Image in the share sheet, after Save the QR code on a form    | `app.json`'s `ios.infoPlist`       |

**Saving a form's QR code** (M17, `expo-sharing`) hands a PNG to the phone's own share sheet rather than writing to the
photo library itself, so the app never asks for the photos. iOS's Save Image in that sheet adds the picture to Photos
on the app's behalf, and asks first with the words above; without them it would close the app instead. `expo-sharing`
has no config plugin for it (its plugin is for receiving shares, which the app doesn't, and isn't in `app.json`), so
the string sits in `ios.infoPlist`.

### The microphone string, decided

`expo-audio` is in the app for one job: playing a voicemail a customer left. It records nothing. The step that built
the inbox found the library had no config plugin, so no microphone string existed and nothing turned `RECORD_AUDIO`
off on purpose — it only happened to be off. In `expo-audio@57.0.5` the plugin exists, and it is now in `app.json`
with everything turned down:

```json
[
  "expo-audio",
  {
    "microphonePermission": false,
    "recordAudioAndroid": false,
    "enableBackgroundPlayback": false,
    "enableBackgroundRecording": false
  }
]
```

So the honest answer is the one the app deserves: **no microphone purpose string at all**, because there is nothing
truthful to put in it. A string saying the app may record would be a worse answer than none, and a missing string is
not a rejection — iOS only rejects an app that _calls_ a microphone API without one, and this app never does. The
plugin's other defaults matter as much: left alone it would have declared `RECORD_AUDIO`, `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_MEDIA_PLAYBACK` and iOS's `audio` background mode, none of which this app should have.

Proof after a prebuild: no `NSMicrophoneUsageDescription` in `Info.plist`, and `UIBackgroundModes` is `["fetch"]`
alone (background sync), not `["fetch", "audio"]`.

### iOS keys that are there but aren't permissions

| Key                                                    | Why                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ITSAppUsesNonExemptEncryption: false`                 | Answers Apple's export-compliance question once instead of every build. See the note in [`listing-app-store.md`](listing-app-store.md)                                                                                                                                                                            |
| `UIBackgroundModes: ["fetch"]`                         | `expo-task-manager` / background sync, so the phone's copy catches up without the app being open                                                                                                                                                                                                                  |
| `NSLocalNetworkUsageDescription`, `NSBonjourServices`  | `expo-dev-launcher` adds these for finding a development server. It also adds a build phase ("[Expo Dev Launcher] Strip Local Network Keys for Release") that deletes both from any non-Debug build, so a store build asks for no local network access. Verified: the phase is in the generated `project.pbxproj` |
| `com.apple.developer.usernotifications.time-sensitive` | The entitlement for time-sensitive notifications (urgent Action Center items)                                                                                                                                                                                                                                     |

### What iOS is never asked for

No microphone, no contacts, no background location, no calendar, no reminders, no health, no Bluetooth, no tracking
prompt. Each is absent because nothing in the app calls it — `expo-contacts` is not a dependency, and adding the business
number to Contacts hands it to the phone's own New Contact screen (`src/inbox/contact-card.ts`).

**Location while in use** (M18, `expo-location`): asked for the first time a tech taps **On my way** on a visit, never
at launch and never in the background. The one reading goes with that tap (rounded to about 100 m) so the customer's
text can say when they'll arrive; it is not kept on the job. `NSLocationWhenInUseUsageDescription` says so, and the
privacy manifest lists coarse location for app functionality. If the tech says no, On my way still works without an
arrival time.

## Android: the merged manifest, permission by permission

### Kept, and why

| Permission                                                           | Asked for by                       | Why the app needs it                                                                              |
| -------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `android.permission.INTERNET`                                        | `app.json`                         | Talking to the API, the sync stream and Supabase                                                  |
| `android.permission.ACCESS_NETWORK_STATE`                            | `expo-updates`, `expo-network`     | Knowing whether there is signal, which every offline screen depends on                            |
| `android.permission.ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`  | `expo-location`                    | One reading when a tech taps On my way, for the customer's arrival time (never in the background) |
| `android.permission.CAMERA`                                          | `expo-image-picker` plugin         | Taking a photo for a customer's record or a reply                                                 |
| `android.permission.USE_BIOMETRIC`, `…USE_FINGERPRINT`               | `expo-local-authentication` plugin | Unlocking, and confirming anything that reaches a customer                                        |
| `android.permission.POST_NOTIFICATIONS`                              | `expo-notifications`               | Showing notifications at all, on Android 13 and later                                             |
| `android.permission.VIBRATE`                                         | `app.json` / `expo-notifications`  | A notification's buzz                                                                             |
| `android.permission.WAKE_LOCK`                                       | `firebase-messaging`               | Waking to receive a push                                                                          |
| `android.permission.RECEIVE_BOOT_COMPLETED`                          | `expo-notifications`               | Scheduled notifications survive a restart                                                         |
| `android.permission.MODIFY_AUDIO_SETTINGS`                           | `expo-audio`                       | Playing a voicemail through the right output. Not a runtime permission and not the microphone     |
| `com.google.android.c2dm.permission.RECEIVE`                         | `firebase-messaging`               | Receiving a push from Firebase                                                                    |
| `com.gobizhelp.handsfreeos.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | `androidx`                         | The app's own signature-level permission, so its internal broadcasts can't be read by other apps  |

### Gone, and why

Each is turned off with `tools:node="remove"`, which the merger honours whatever a library asks for. The two storage
ones are in `app.json`'s `android.blockedPermissions` (from the step that built photos); the rest are in
`app.config.ts`'s `BLOCKED_PERMISSIONS`, each with its reason beside it in the code.

| Permission                                                                                                                      | Asked for by                                                  | Why it's gone                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `android.permission.READ_EXTERNAL_STORAGE`, `…WRITE_EXTERNAL_STORAGE`                                                           | `expo-file-system`, `expo-image-picker` (up to Android 12)    | The app keeps everything in its own folder                                                                                                                                               |
| `android.permission.RECORD_AUDIO`                                                                                               | would come from `expo-image-picker` and `expo-audio` defaults | The app records nothing                                                                                                                                                                  |
| `android.permission.SYSTEM_ALERT_WINDOW`                                                                                        | Expo's Android template                                       | It is there so a debug build can draw React Native's dev menu over other apps. A store build has no dev menu, and Play makes you justify "display over other apps"                       |
| `android.permission.ACCESS_WIFI_STATE`                                                                                          | `expo-network`                                                | Only needed for `getIpAddressAsync`. `src/lib/network.ts` only ever asks whether there is signal                                                                                         |
| `com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE`                                                        | `expo-application`, under `expo-notifications`                | Play's install-referrer library, for which ad installed the app. Nothing asks                                                                                                            |
| `android.permission.READ_APP_BADGE` and 18 launcher-specific badge permissions (Samsung, Huawei, Sony, Oppo, HTC, and the rest) | ShortcutBadger, under `expo-notifications`                    | Nothing sets a count on the launcher icon — not the app, not the worker's push payloads. Twenty permissions for a feature that doesn't exist, and a Play listing shorter by twenty lines |

### Never asked for

No `READ_CONTACTS` or `WRITE_CONTACTS`, no `READ_CALENDAR`, no `READ_PHONE_STATE` or `CALL_PHONE` (calling goes
through the phone's own dialler and the carrier), no `com.google.android.gms.permission.AD_ID`, no `READ_MEDIA_IMAGES`,
and no `QUERY_ALL_PACKAGES`. The manifest's `<queries>` blocks ask only which app opens an `https` link, which is what
opening the web app needs, and which apps take a shared file (`ACTION_SEND`, from `expo-sharing`), which is what saving
a form's QR code through the share sheet needs. `expo-sharing` also adds its own `FileProvider`, not exported, which
lends the one picture to the app the person picks; it asks for no permission.

### What `usesCleartextTraffic` is doing there

`app.config.ts` turns plain HTTP on **only** when `EXPO_PUBLIC_E2E=1`, so the Maestro test builds can reach a stack on
the computer running the emulator over `10.0.2.2`. A store build is built without that variable and refuses plain HTTP.
Worth checking on the first production build: `usesCleartextTraffic` must be absent from the merged manifest.
