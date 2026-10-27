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

| Key                                 | Words shown                                                                                                                                                   | Asked when                                                                                                                                                    | Set by                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `NSCameraUsageDescription`          | "HandsFreeOS uses the camera to take photos for your customers’ records, and to show you in the HandsFreeOS video calls you join."                            | Taking a photo for a customer’s record or a reply, or the camera on in a HandsFreeOS video call (Join with the camera on, or Start video)                     | `expo-image-picker` and `@config-plugins/react-native-webrtc` plugins               |
| `NSPhotoLibraryUsageDescription`    | "HandsFreeOS adds the photos you choose to your customers' records."                                                                                          | Choosing a photo already on the phone                                                                                                                         | `expo-image-picker` plugin                                                          |
| `NSFaceIDUsageDescription`          | "Face ID unlocks HandsFreeOS on this iPhone."                                                                                                                 | Unlocking the app, and confirming anything that reaches a customer                                                                                            | `expo-local-authentication` plugin                                                  |
| `NSPhotoLibraryAddUsageDescription` | "HandsFreeOS saves the QR codes you choose to save to your photos."                                                                                           | Save Image in the share sheet, after Save the QR code on a form                                                                                               | `app.json`'s `ios.infoPlist`                                                        |
| `NSMicrophoneUsageDescription`      | "HandsFreeOS uses the microphone only while you talk out loud to the Assistant or your AI teammate, record a voice note, or are in a HandsFreeOS video call." | The first tap on a mic (the Assistant’s, Talk out loud on a test call, or a voice note on a deal), or joining a HandsFreeOS video call with the microphone on | `expo-audio`, `expo-image-picker` and `@config-plugins/react-native-webrtc` plugins |

**Saving a form's QR code** (M17, `expo-sharing`) hands a PNG to the phone's own share sheet rather than writing to the
photo library itself, so the app never asks for the photos. iOS's Save Image in that sheet adds the picture to Photos
on the app's behalf, and asks first with the words above; without them it would close the app instead. `expo-sharing`
has no config plugin for it (its plugin is for receiving shares, which the app doesn't, and isn't in `app.json`), so
the string sits in `ios.infoPlist`.

### The microphone, decided

`expo-audio` was in the app for one job, playing a voicemail a customer left, and the app recorded nothing, so it
asked for no microphone at all. Talking out loud changed that: the Assistant's mic, and **Talk out loud** on a test
call of the AI teammate, record what the person says, one turn at a time, and send it to HandsFreeOS to be turned into
words (`src/voice/`). So the app now asks, the first time someone taps a mic and never before, with words that say
exactly that:

```json
[
  "expo-audio",
  {
    "microphonePermission": "HandsFreeOS uses the microphone only while you talk out loud to the Assistant or your AI teammate, or record a voice note.",
    "recordAudioAndroid": true,
    "enableBackgroundPlayback": false,
    "enableBackgroundRecording": false
  }
]
```

`expo-image-picker` carries the same string. It records nothing itself (photos only), but its plugin writes the same
`NSMicrophoneUsageDescription` key, and set to `false` it deletes the key on iOS and blocks `RECORD_AUDIO` on Android
whatever `expo-audio` asks for. Both saying the same words means the order the plugins run in doesn't matter.

What stays off matters as much: no background recording and no background playback, so no
`FOREGROUND_SERVICE_MEDIA_PLAYBACK` or `…_MICROPHONE`, and no iOS `audio` background mode (the one foreground service
is a check-in's location, below). The microphone records only
while the screen is open and listening; each recording to the Assistant or a test call is deleted once it has been
heard, and each clip once it has played. A voice note is the one recording kept: it's the note, filed on its deal.

**A HandsFreeOS video call** (docs/video-calls.md, "On the phone") is the other time the microphone, and the camera,
are on: from Join, with whatever the person picked before it, until they leave. The sound and video go live to the
others in the call, and the sound to the AI's listener while the call's AI notes are on; nothing is recorded on the
phone or kept anywhere. LiveKit's plugin (`@config-plugins/react-native-webrtc`) writes the same two keys as the
others, so it carries the same words. It adds no background mode either: the call's camera and microphone stop when
the person leaves the app.

Proof after a prebuild: `NSMicrophoneUsageDescription` in `Info.plist` with the words above, no `audio` in
`UIBackgroundModes`, and `RECORD_AUDIO` in the merged manifest without `tools:node="remove"`.

### iOS keys that are there but aren't permissions

| Key                                                    | Why                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ITSAppUsesNonExemptEncryption: false`                 | Answers Apple's export-compliance question once instead of every build. See the note in [`listing-app-store.md`](listing-app-store.md)                                                                                                                                                                            |
| `UIBackgroundModes: ["fetch", "location"]`             | `fetch`: `expo-task-manager` / background sync, so the phone's copy catches up without the app being open. `location`: `expo-location`, so a check-in sharing where the person is keeps sharing with the app in the background, until they check out (below)                                                      |
| `NSLocalNetworkUsageDescription`, `NSBonjourServices`  | `expo-dev-launcher` adds these for finding a development server. It also adds a build phase ("[Expo Dev Launcher] Strip Local Network Keys for Release") that deletes both from any non-Debug build, so a store build asks for no local network access. Verified: the phase is in the generated `project.pbxproj` |
| `com.apple.developer.usernotifications.time-sensitive` | The entitlement for time-sensitive notifications (urgent Action Center items)                                                                                                                                                                                                                                     |

### What iOS is never asked for

No contacts, no "Always" location, no calendar, no reminders, no health, no Bluetooth, no tracking
prompt. Each is absent because nothing in the app calls it — `expo-contacts` is not a dependency. Picking a customer from
Contacts (More → Customers, and the setup's customers stop) uses the system's own contact picker
(`CNContactPickerViewController`, in `modules/hfos-phone`), which runs outside the app and hands it only the one contact
picked, so iOS asks nothing; adding the business number to Contacts hands it to the phone's own New Contact screen
(`src/inbox/contact-card.ts`).

**Location while in use** (M18, `expo-location`): asked for the first time a tech taps **On my way** on a visit, never
at launch and never in the background. The one reading goes with that tap, and the server rounds it to about 100 m, so
the customer's text can say when they'll arrive; it is not kept on the job. `NSLocationWhenInUseUsageDescription` says
so, and the privacy manifest lists precise and coarse location for app functionality. If the tech says no, On my way still works without an
arrival time.

**Check-ins** (Real Estate round six, a core feature) take one reading too, only when the person checks in somewhere
or taps Help, so the contacts they chose can be told where they were. A check-in without a reading still works, with
the place they typed.

**A check-in that shares where the person is** (round seven; Chris decided 2026-10-05) is the one time the app follows
the phone with the app in the background: from checking in with **Share where I am until I check out** on, until they
check out, answer the reminder, or the check-in ends anywhere else (`src/safety/follow.ts`). It needs no more than the
"while using the app" permission above: iOS keeps the updates going under the `location` background mode and shows its
blue location sign the whole time (`showsBackgroundLocationIndicator`), so the person always sees it; the app never
asks for "Always". At most one reading every 2 minutes, and only after moving 100 m. Only the latest spot is kept,
never a trail, and it is cleared 30 days after the check-in ends. With the switch off, nothing follows.

For App Review, the `location` background mode needs a line in the review notes: "Background location is used only
while the person is checked in for their safety (Settings → My safety; Check in on an appointment) with Share where I
am on, and stops when they check out. The blue location indicator shows throughout. The app never requests Always
authorization."

**Voice notes** (Real Estate round six) record only while the person holds the record button on a deal's note; the
recording is put into words on the server and kept on the deal like any file.

## Android: the merged manifest, permission by permission

### Kept, and why

| Permission                                                              | Asked for by                                                                                  | Why the app needs it                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `android.permission.INTERNET`                                           | `app.json`                                                                                    | Talking to the API, the sync stream and Supabase                                                                                                                                                                                          |
| `android.permission.ACCESS_NETWORK_STATE`                               | `expo-updates`, `expo-network`                                                                | Knowing whether there is signal, which every offline screen depends on                                                                                                                                                                    |
| `android.permission.ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`     | `expo-location`                                                                               | One reading when a tech taps On my way, or someone checks in or taps Help                                                                                                                                                                 |
| `android.permission.FOREGROUND_SERVICE`, `…FOREGROUND_SERVICE_LOCATION` | `expo-location` plugin; `@livekit/react-native` asks for `FOREGROUND_SERVICE` too             | A check-in sharing where the person is, until they check out, with its notification showing                                                                                                                                               |
| `android.permission.CAMERA`                                             | `expo-image-picker` plugin; `@config-plugins/react-native-webrtc` and `@livekit/react-native` | Taking a photo for a customer’s record or a reply, and the camera in a HandsFreeOS video call                                                                                                                                             |
| `android.permission.USE_BIOMETRIC`, `…USE_FINGERPRINT`                  | `expo-local-authentication` plugin                                                            | Unlocking, and confirming anything that reaches a customer                                                                                                                                                                                |
| `android.permission.POST_NOTIFICATIONS`                                 | `expo-notifications`                                                                          | Showing notifications at all, on Android 13 and later                                                                                                                                                                                     |
| `android.permission.VIBRATE`                                            | `app.json` / `expo-notifications`                                                             | A notification's buzz                                                                                                                                                                                                                     |
| `android.permission.WAKE_LOCK`                                          | `firebase-messaging`; `@config-plugins/react-native-webrtc` and `@livekit/react-native`       | Waking to receive a push, and keeping a video call’s sound going                                                                                                                                                                          |
| `android.permission.RECEIVE_BOOT_COMPLETED`                             | `expo-notifications`                                                                          | Scheduled notifications survive a restart                                                                                                                                                                                                 |
| `android.permission.MODIFY_AUDIO_SETTINGS`                              | `expo-audio`; `@config-plugins/react-native-webrtc` and `@livekit/react-native`               | Playing a voicemail, and a video call’s sound, through the right output (speaker, earpiece or headphones). Not a runtime permission and not the microphone                                                                                |
| `android.permission.RECORD_AUDIO`                                       | `expo-audio` plugin; `@config-plugins/react-native-webrtc` and `@livekit/react-native`        | Talking out loud (the Assistant’s mic, a test call), voice notes, and a HandsFreeOS video call. Asked on the first tap, or the first Join with the microphone on                                                                          |
| `android.permission.BLUETOOTH`, `…BLUETOOTH_ADMIN`                      | `@livekit/react-native`; `@config-plugins/react-native-webrtc` asks for `BLUETOOTH`           | A video call’s sound in a Bluetooth headset, on Android 11 and earlier. Normal permissions: nothing is asked. Android 12 and later needs `BLUETOOTH_CONNECT` for that, which the app doesn’t ask for yet (docs/video-calls.md, "Not yet") |
| `com.google.android.c2dm.permission.RECEIVE`                            | `firebase-messaging`                                                                          | Receiving a push from Firebase                                                                                                                                                                                                            |
| `com.gobizhelp.handsfreeos.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`    | `androidx`                                                                                    | The app's own signature-level permission, so its internal broadcasts can't be read by other apps                                                                                                                                          |

**A check-in that shares where the person is** (round seven) runs as a location foreground service, started from the
Check in tap with the app open, so it needs only the location permission the person already gave: no
`ACCESS_BACKGROUND_LOCATION`, which stays blocked in `app.json`. Its notification ("Sharing where you are · Until you
check out of …") shows the whole time, with the app's monochrome icon (`androidForegroundServiceIcon`). Play asks
about `FOREGROUND_SERVICE_LOCATION` once: in Play Console → App content → Foreground service permissions, choose
Location, say "Shares the person's location with the safety contacts they chose, only while they are checked in at an
appointment, until they check out", and attach a short video of checking in with the switch on, the notification
showing, and checking out.

**LiveKit's screen share service.** LiveKit's WebRTC library brings `com.oney.WebRTCModule.MediaProjectionService`, a
foreground service of type `mediaProjection`, for sharing the phone's screen in a call. Phones share no screen in a
HandsFreeOS call yet, so `app.config.ts` takes it out of the merged manifest (`tools:node="remove"`): no
`FOREGROUND_SERVICE_MEDIA_PROJECTION`, and nothing for Play to ask about. Proof after a release build: the merged
manifest has no `MediaProjectionService`.

### Gone, and why

Each is turned off with `tools:node="remove"`, which the merger honours whatever a library asks for. The two storage
ones (from the step that built photos) and background location are in `app.json`'s `android.blockedPermissions`; the rest are in
`app.config.ts`'s `BLOCKED_PERMISSIONS`, each with its reason beside it in the code.

| Permission                                                                                                                      | Asked for by                                                   | Why it's gone                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `android.permission.READ_EXTERNAL_STORAGE`, `…WRITE_EXTERNAL_STORAGE`                                                           | `expo-file-system`, `expo-image-picker` (up to Android 12)     | The app keeps everything in its own folder                                                                                                                                               |
| `android.permission.ACCESS_BACKGROUND_LOCATION`                                                                                 | Nothing yet; blocked in case a library ever does               | A check-in follows the phone through a foreground service, which needs only the "while using the app" permission. Play reviews background location far more strictly                     |
| `android.permission.SYSTEM_ALERT_WINDOW`                                                                                        | Expo’s Android template, `@config-plugins/react-native-webrtc` | It is there so a debug build can draw React Native's dev menu over other apps. A store build has no dev menu, and Play makes you justify "display over other apps"                       |
| `android.permission.ACCESS_WIFI_STATE`                                                                                          | `expo-network`                                                 | Only needed for `getIpAddressAsync`. `src/lib/network.ts` only ever asks whether there is signal                                                                                         |
| `com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE`                                                        | `expo-application`, under `expo-notifications`                 | Play's install-referrer library, for which ad installed the app. Nothing asks                                                                                                            |
| `android.permission.READ_APP_BADGE` and 18 launcher-specific badge permissions (Samsung, Huawei, Sony, Oppo, HTC, and the rest) | ShortcutBadger, under `expo-notifications`                     | Nothing sets a count on the launcher icon — not the app, not the worker's push payloads. Twenty permissions for a feature that doesn't exist, and a Play listing shorter by twenty lines |

### Never asked for

No `READ_CONTACTS` or `WRITE_CONTACTS`: picking a customer from the contacts uses the contacts app's own picker
(`ACTION_PICK` on phone numbers, in `modules/hfos-phone`), which lends the app the one row picked, a name and a number,
and nothing else. No `READ_CALENDAR`, no `READ_PHONE_STATE` or `CALL_PHONE` (calling goes
through the phone's own dialler and the carrier), no `com.google.android.gms.permission.AD_ID`, no `READ_MEDIA_IMAGES`,
and no `QUERY_ALL_PACKAGES`. The manifest's `<queries>` blocks ask only which app opens an `https` link, which is what
opening the web app needs, and which apps take a shared file (`ACTION_SEND`, from `expo-sharing`), which is what saving
a form's QR code through the share sheet needs. `expo-sharing` also adds its own `FileProvider`, not exported, which
lends the one picture to the app the person picks; it asks for no permission.

### What `usesCleartextTraffic` is doing there

`app.config.ts` turns plain HTTP on **only** when `EXPO_PUBLIC_E2E=1`, so the Maestro test builds can reach a stack on
the computer running the emulator over `10.0.2.2`. A store build is built without that variable and refuses plain HTTP.
Worth checking on the first production build: `usesCleartextTraffic` must be absent from the merged manifest.
