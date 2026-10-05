# HandsFreeOS Social: the browser extension

The extension that will work beside a person on Facebook, and later LinkedIn and Instagram, for the Social Outreach
add-on. It connects to HandsFreeOS only for businesses that have that add-on on.

**This is the first test build (Phase 0).** It reads the Facebook page you have open and shows what it found in
Chrome's side panel. It doesn't sign in to HandsFreeOS, saves nothing, sends nothing, and never clicks, scrolls or
changes the page. It's here to show how reliably Facebook can be read before anything is built on it.

## What it reads

| Page                                        | What it shows                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A profile                                   | Name, bio and details, whether you're friends, mutual friends, recent posts                          |
| Friends, followers, following, friends list | Each person, with the line under their name                                                          |
| A group's People tab                        | The group, and each member with the list they're in; admins and moderators are marked to leave alone |
| A group                                     | The group (public or private, members, joined or not) and its posts                                  |
| Your groups                                 | Each group, with the line under its name                                                             |
| Search results                              | People, groups and posts                                                                             |
| Chats, and an open chat                     | Each chat with its last message; an open chat's messages, who sent each, when                        |
| Notifications                               | Who accepted your request, reacted, commented or mentioned you                                       |
| Any page                                    | Facebook's warnings: a temporary block, a limit, a security check                                    |

Facebook loads lists as you scroll, so the extension only sees what's on the page. With **Read when the page
changes** on, the panel reads again as Facebook adds to the page, and when you reload it or go somewhere new;
otherwise press **Read this page**. A group's People tab shows only a few of each list, admins and moderators too:
its **See all** pages are read the same way.

Facebook draws some pages two ways, and both are read. Since 2026 a profile can have its name, bio and details at the
top instead of an Intro card, a group's People tab has a row of faces above its tabs (left out: the lists below say
who each person is), an open chat repeats each message after it for screen readers (read once), and posts in the
News Feed aren't articles while their comments are (comments are never read as posts).

## Load it in Chrome

1. Build it: `pnpm --filter @hfos/extension build`. It lands in `apps/extension/dist/chrome`.
2. Open `chrome://extensions`, turn on **Developer mode**, press **Load unpacked** and pick that folder.
3. Pin it from the puzzle-piece menu, open facebook.com, and press its button: the side panel opens beside the page.

After a rebuild, press the reload arrow on the extension's card. A Facebook tab that was open before the extension was
loaded gets the reader the first time the panel asks.

`node scripts/build.mjs --watch` rebuilds on every change.

## When it reads a page wrong

**Copy page outline** and **Save page outline**, at the foot of the panel, give the page's structure as plain text:
tags, roles, Facebook's own words and labels, and the shape of every link. Everything a person wrote becomes
`[2 words]`, and the people, groups and chats that links lead to become `{1}`, `{2}`…, the same number each time the
same one comes up. With the reader's counts at the top, that's enough to see what Facebook changed and fix the reader.

## Rules worth knowing before changing anything

- **Addresses first.** `src/facebook/urls.ts` decides what kind of page it is and what each link points to. Facebook
  changes its page code every week and its addresses hardly ever, so anything a link can tell, a link tells.
- **Never a class name.** Facebook's are scrambled and change constantly. The readers use links, roles, ARIA labels,
  headings and Facebook's own words (`src/facebook/vocabulary.ts`), in English for now.
- **Found by its link.** A person, group or chat is found by the link to it, and read from the largest box around that
  link that holds no link to anything else of the same sort (`collectLinked` in `src/facebook/dom.ts`).
- **Reading only, and only when asked.** The content script answers the panel and nothing else: it reads when the
  panel asks, and while the panel watches its tab it says when the page has changed, so the panel can ask again. It
  never writes to the page, clicks, scrolls or sends anything. Later phases keep the owner's decisions: you press
  send by default, daily limits, and a stop for the day on any Facebook warning.
- **Each reader checks itself.** When a page should have something and the reader finds none, the panel says so and
  asks for the outline (`src/facebook/page.ts`).
- **An outline never holds what a person wrote.** `test/outline.test.ts` checks that no name, message or id survives.
- **No remote code.** Everything ships in the bundle; the stores forbid downloading code.
- **No real Facebook pages in the repo.** The pages in `test/fixtures` are written by hand to look like Facebook's.
  A saved real page holds other people's names and messages, so tune the readers from outlines instead.

## Where things are

| Path                    | What it is                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `src/facebook/`         | The readers: one file per kind of page, the address rules, Facebook's words and the outline |
| `src/content.ts`        | The script in each Facebook tab: reads the page when the panel asks                         |
| `src/panel/`, `public/` | The side panel                                                                              |
| `src/background.ts`     | Opens the side panel from the toolbar button                                                |
| `scripts/build.mjs`     | Bundles with esbuild and writes `manifest.json`, with the version from `package.json`       |
| `test/`                 | The readers against the hand-written pages, the addresses, and the outline's hiding         |

## Next

Phase 1 adds signing in to HandsFreeOS, as the phone app does, and saving what it reads through the Social Outreach
add-on's commands. It lists only the businesses where the add-on is on and the person may use it, and stops when the
add-on is turned off. Safari on Mac follows in Phase 2.
