# The app's store listings

Everything the App Store and Play Console ask for, kept here so it can be edited and reviewed like code instead of
being typed straight into a console and forgotten. Nothing here is submitted automatically; someone copies it in.

The app is **HandsFreeOS** everywhere — name, icon, listing — published under **Go Biz Help's own** Apple and Google
accounts. It is one app, not a white label per client.

| File                                           | What it is                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| [`listing-app-store.md`](listing-app-store.md) | Name, subtitle, keywords, description, URLs, review notes for Apple    |
| [`listing-play.md`](listing-play.md)           | Name, short and full description, category, URLs for Google            |
| [`privacy-app-store.md`](privacy-app-store.md) | Apple's App Privacy answers, every row traced to code                  |
| [`privacy-play.md`](privacy-play.md)           | Google's Data Safety answers, every row traced to code                 |
| [`permissions.md`](permissions.md)             | Every permission on both platforms: why it's there, or why it's gone   |
| [`age-rating.md`](age-rating.md)               | Apple's age-rating answers and Google's content-rating (IARC) answers  |
| [`reviewer-demo.md`](reviewer-demo.md)         | The demo business a reviewer signs into, and how to seed it            |
| [`screenshots.md`](screenshots.md)             | Which screenshots each store wants, which exist, and which are missing |
| [`release-checklist.md`](release-checklist.md) | What to do once the developer accounts exist, in order                 |
| `assets/`                                      | The listing icons and the feature graphic                              |

## The assets

Generated from `design/brand/handsfreeos-icon.png` by `node scripts/mobile-icons.mjs`; that script's header says how.
Don't edit them by hand — change the master and run it again.

| File                                       | Size      | Where it goes                                  |
| ------------------------------------------ | --------- | ---------------------------------------------- |
| `assets/app-store-icon-1024.png`           | 1024×1024 | App Store Connect → App Information → App Icon |
| `assets/play-icon-512.png`                 | 512×512   | Play Console → Store listing → App icon        |
| `assets/play-feature-graphic-1024x500.png` | 1024×500  | Play Console → Store listing → Feature graphic |

The App Store icon has no alpha channel at all, which is what Apple checks for. The feature graphic is the mark on the
brand's pale blue: honest and clean, but it carries no words, so it is the one asset worth handing to a designer before
the listing goes public.

## The app's own icons and splash

Not here — they are app config, in `apps/mobile/assets/images/` and named in `apps/mobile/app.json`. `expo prebuild`
makes every size and density each platform installs from those, so no per-density file is checked in.

## What is still missing

A list lives in [`release-checklist.md`](release-checklist.md), with what is done and how that is known. The short
version, as of 2026-09-19: the iOS side has reached TestFlight and works. What is left is the demo business a
reviewer signs into (nothing can be submitted without it), the Google Play account and app record, and filling both
consoles from the files here.
