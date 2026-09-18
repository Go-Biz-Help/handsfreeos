# Store screenshots: what's wanted, what exists, what's missing

Short version: **every screenshot taken so far is the wrong size for both stores**, and none of them can be made right
by resizing. Six screens need retaking on two specific devices. Nothing else about the listing waits on a phone.

## What each store wants

### App Store Connect

| Slot                          | Size                             | Required?                                                                                                            |
| ----------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| iPhone 6.9" display, portrait | **1320 × 2868** (or 1290 × 2796) | Yes — the only required iPhone size now, and it stands in for every smaller iPhone                                   |
| iPad 13", portrait            | 2064 × 2752                      | **No** — the app is iPhone-only (`TARGETED_DEVICE_FAMILY = "1"` in the generated Xcode project), so Apple never asks |
| Count                         | 1 minimum, 10 maximum per size   | —                                                                                                                    |
| App preview (video)           | Optional                         | Not planned for the first submission                                                                                 |

The 6.9" device in the simulator is an **iPhone 17 Pro Max** (or 16 Pro Max): both render 1320 × 2868.

### Play Console

| Slot               | Size                                                                     | Required?                    |
| ------------------ | ------------------------------------------------------------------------ | ---------------------------- |
| Phone screenshots  | 2 to 8 images, each side 320–3840 px, aspect ratio between 9:16 and 16:9 | Yes                          |
| App icon           | 512 × 512 — `assets/play-icon-512.png`                                   | Done                         |
| Feature graphic    | 1024 × 500 — `assets/play-feature-graphic-1024x500.png`                  | Done                         |
| Tablet screenshots | 7" and 10"                                                               | No — tablets aren't a target |

## What exists today

Taken by the steps that built the screens, all in the scratchpads, all in light **and** dark on both phones:

| Step | Folder                     | Screens                                                                                  |
| ---- | -------------------------- | ---------------------------------------------------------------------------------------- |
| 13   | `m10-step13/screens`       | Home (the Action Center), its groups and sheets, approvals, More                         |
| 14   | `m10-step14/screens`       | Inbox threads, held texts, photo replies, calls, voicemail, My cell                      |
| 15   | `m10-step15/screens`       | Customers, one customer's 360, the pipeline, leads, tasks, search, and the offline queue |
| 16   | `m10-step16/screens/final` | Calendar day and appointment, money list, an invoice, recording cash                     |
| 17   | (in progress)              | Assistant, More, Settings                                                                |

Sizes, measured:

| Platform | Size measured                        | Store's rule                     | Usable?                                                                                                     |
| -------- | ------------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| iOS      | 1206 × 2622 (iPhone 16/17 Pro, 6.3") | 1320 × 2868 or 1290 × 2796       | **No.** Not an accepted size, and upscaling 1206 → 1320 would be visibly soft and may be rejected anyway    |
| Android  | 1080 × 2424 (1 : 2.24)               | between 9:16 (1 : 1.78) and 16:9 | **No.** Too tall. Padding it to 9:16 would work mechanically but leaves thick bars and looks like a mistake |

So: useful as proof that the screens work, not as store art.

## What to take in the second half, and from which existing shot

Six screens, one story: _the day, from the truck_. Take each on **iPhone 17 Pro Max (1320 × 2868)** and an **Android
emulator at 1080 × 1920**, in **light mode**, from the demo business
([`reviewer-demo.md`](reviewer-demo.md)) so the data is the same in both and is the same data a reviewer sees.

| #   | Screen                                       | The shot to copy                                                      |
| --- | -------------------------------------------- | --------------------------------------------------------------------- |
| 1   | Home — what needs you today                  | `m10-step13/screens/ios-home-top-light.png`                           |
| 2   | Inbox — a customer thread with a photo reply | `m10-step14/screens/ios-inbox-photo-reply-sent.png`                   |
| 3   | A customer's whole history                   | `m10-step15/screens/ios-customer-light.png`                           |
| 4   | The calendar day, with an appointment        | `m10-step16/screens/final/…-calendar-day-light.png` (iOS equivalent)  |
| 5   | An invoice, and recording cash               | `m10-step16/screens/final/…-money-invoice-light.png` (iOS equivalent) |
| 6   | Works with no signal — the waiting queue     | `m10-step15/screens/ios-offline-four.png`                             |

Two more worth adding if there is room: the pipeline (`ios-pipeline-light.png`) and the Assistant, once step 17's
screens land.

Dark-mode shots are optional in both stores; skip them for the first submission and keep the set to one story.

## Things that will trip up a retake

- **Take them from the demo business, not the dev seed.** The dev seed's business is called Lone Star HVAC & Roofing
  and belongs to the development stack. A reviewer sees Bright Path Home Services, and a listing that matches what the
  reviewer sees is one less thing to explain.
- **No real names or numbers.** Everything in the demo business is a 555 number and an `example.com` address, so this
  is already true — just don't mix in a screenshot from the dev seed, which has `.test` staff emails in a few places.
- **The status strip.** The clock, battery and carrier are part of the frame. The simulator shows a tidy 9:41; an
  Android emulator does not, so set the emulator's clock and turn off the notification shade icons before shooting.
- **Nothing half-loaded.** A skeleton row or an empty state in a screenshot reads as a broken app.
