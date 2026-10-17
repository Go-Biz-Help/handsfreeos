# Store screenshots: what's wanted, and what exists

Short version: **the screenshots are taken and both stores will accept them.** Sixteen files in
`assets/screenshots/` — eight per platform, at each store's own size, in light mode, one story each. Nothing about
the listing waits on a phone any more.

## What each store wants

### App Store Connect

| Slot                          | Size                             | Required?                                                                                                            |
| ----------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| iPhone 6.9" display, portrait | **1320 × 2868** (or 1290 × 2796) | Yes — the only required iPhone size now, and it stands in for every smaller iPhone                                   |
| iPad 13", portrait            | 2064 × 2752                      | **No** — the app is iPhone-only (`TARGETED_DEVICE_FAMILY = "1"` in the generated Xcode project), so Apple never asks |
| Count                         | 1 minimum, 10 maximum per size   | Eight are here, so there is room for two more                                                                        |
| App preview (video)           | Optional                         | Not planned for the first submission                                                                                 |

The 6.9" device in the simulator is an **iPhone 17 Pro Max** (or 16 Pro Max): both render 1320 × 2868.

### Play Console

| Slot               | Size                                                                     | Required?                                           |
| ------------------ | ------------------------------------------------------------------------ | --------------------------------------------------- |
| Phone screenshots  | 2 to 8 images, each side 320–3840 px, aspect ratio between 9:16 and 16:9 | Yes — eight are here, which is Google's **maximum** |
| App icon           | 512 × 512 — `assets/play-icon-512.png`                                   | Done                                                |
| Feature graphic    | 1024 × 500 — `assets/play-feature-graphic-1024x500.png`                  | Done                                                |
| Tablet screenshots | 7" and 10"                                                               | No — tablets aren't a target                        |

## What exists

In `assets/screenshots/`, measured from the files themselves. The same eight screens on both platforms, so the two
listings tell one story:

| Order | File                    | Screen                                   |
| ----- | ----------------------- | ---------------------------------------- |
| 1     | `…-1-home.png`          | Home — what needs you today              |
| 2     | `…-2-pipeline.png`      | The pipeline                             |
| 3     | `…-3-customer.png`      | A customer's whole history               |
| 4     | `…-4-calendar.png`      | The calendar day, with an appointment    |
| 5     | `…-5-invoice.png`       | An invoice                               |
| 5b    | `…-5b-record-cash.png`  | Recording cash against it                |
| 6     | `…-6-offline-queue.png` | Works with no signal — the waiting queue |
| 7     | `…-7-money-list.png`    | The money list                           |

| Platform | Prefix     | Size measured | Store's rule                      | Usable?                                  |
| -------- | ---------- | ------------- | --------------------------------- | ---------------------------------------- |
| iOS      | `ios-`     | 1320 × 2868   | 1320 × 2868 or 1290 × 2796        | **Yes** — exactly the required 6.9" size |
| Android  | `android-` | 1080 × 1920   | between 9:16 and 16:9, 320–3840px | **Yes** — 9:16 exactly                   |

All sixteen are light mode. Dark-mode shots are optional in both stores and are deliberately not included: one story,
one appearance.

**Two things the set does not have**, neither of them blocking:

- **No Inbox screenshot.** A customer thread with a photo reply was meant to be second in the story and isn't in the
  set. It is arguably the most persuasive screen the app has — texting a customer back from the truck — so it is the
  first thing to add if these are ever revisited. On Android that means dropping one of the eight, because eight is
  Google's maximum.
- **No Assistant screenshot**, for the same reason.

## The marketing versions

`assets/marketing/` has each of the sixteen set in a phone on the brand's blue, under a two-line headline and a line
saying what it shows, at the same sizes as the plain ones; and a Play feature graphic with the name, "Run your day
from your truck." and a phone on it. `node scripts/store-marketing.mjs` makes them all from the plain screenshots, so
retaking a screenshot or changing a headline (its `SLIDES` list) is followed by running it again.

They are what goes in the listing, in the same order; the plain ones stay as their source. In App Store Connect they
go in the **iPhone 6.9" Display** slot: dropped into the 6.1"/6.3" slot, Apple refuses them as "File dimensions are
invalid", because that slot wants 1206 × 2622.

## If these are ever retaken

Take them on **iPhone 17 Pro Max (1320 × 2868)** and an **Android emulator at 1080 × 1920**, in **light mode**, from
the demo business ([`reviewer-demo.md`](reviewer-demo.md)) so both platforms show the same data and it is the same
data a reviewer sees.

- **Take them from the demo business, not the dev seed.** The dev seed's business is called Lone Star HVAC & Roofing
  and belongs to the development stack. A reviewer sees Bright Path Home Services, and a listing that matches what the
  reviewer sees is one less thing to explain.
- **No real names or numbers.** Everything in the demo business is a 555 number and an `example.com` address, so this
  is already true — just don't mix in a screenshot from the dev seed, which has `.test` staff emails in a few places.
- **The status strip.** The clock, battery and carrier are part of the frame. The simulator shows a tidy 9:41; an
  Android emulator does not, so set the emulator's clock and turn off the notification shade icons before shooting.
- **Nothing half-loaded.** A skeleton row or an empty state in a screenshot reads as a broken app.
- **Don't resize to fix a size.** Neither store's size can be reached by scaling another one without visible softness,
  and Apple rejects sizes it doesn't recognise. Take them on the right device instead.
