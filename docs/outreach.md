# Social Outreach

Social Outreach is an add-on (id `outreach`, in Sales) and a browser extension (`apps/extension`) that work beside a
person on Facebook, and later LinkedIn and Instagram. The extension reads the page they have open; the add-on keeps
the people they find there, their chats with them, and the business's playbooks in HandsFreeOS.

It's in `development`: offered to nobody, and installable only where HandsFreeOS staff hand it out to try
(docs/addon-architecture.md, "Handing one out to try").

## What's built

Phase 1, steps 1 and 2:

- **Playbooks** (`/a/outreach`): what the business is looking for on social media, how it sounds and which of its
  tags to use. Each has a goal, an offer and link, who it's for, signs to look for and who to skip, where to look, the
  steps it takes, the tone, sample messages, questions, words to avoid, a disclaimer and the tags. The first template
  is **CRM demos**; a blank one is always there.
- **Saving from the extension**: signed in, the extension saves the Facebook profile or chat open beside it when the
  person presses its button, and marks the people and chats on any page that are saved already
  (apps/extension/README.md, "Signing in and saving").
- **A Social card on each customer** (`person.panels`): their Facebook profile, and each chat saved with them.

## How it fits together

| Piece                                                  | Where                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Manifest, operations, tables, shapes                   | `packages/core/src/addons/outreach/`                                             |
| What a save takes: lengths, counts, id shapes (no zod) | `packages/core/src/addons/outreach/limits.ts`                                    |
| Worker half (nothing yet)                              | `apps/worker/src/addons/outreach/`                                               |
| Playbooks page and the Social card                     | `apps/web/src/addons/outreach/`, `/a/outreach`                                   |
| Tables and permissions                                 | `supabase/migrations/20261024000100_addon_outreach.sql`, schema `addon_outreach` |
| The extension                                          | `apps/extension`                                                                 |

Operations, all through the kernel:

| Operation                                             | Who               | What                                                                                                 |
| ----------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------- |
| `outreach.playbook.list`                              | `outreach.use`    | The playbooks, those in use first                                                                    |
| `outreach.playbook.save`, `outreach.playbook.archive` | `outreach.manage` | Write one; put one away or bring it back                                                             |
| `outreach.profile.save`                               | `outreach.use`    | A profile as the extension read it: finds the customer it's saved to, or the one picked, or adds one |
| `outreach.chat.save`                                  | `outreach.use`    | A chat as read: the new messages join what was saved                                                 |
| `outreach.lookup`                                     | `outreach.use`    | Which profiles and chats on a page are saved, and who in Contacts has a name                         |
| `outreach.person`                                     | `outreach.use`    | A customer's profiles and chats, for the Social card                                                 |

Permissions: **Use Social Outreach** (`outreach.use`, owners, admins and members) and **Run Social Outreach**
(`outreach.manage`, owners and admins, which needs `outreach.use`).

The extension calls these like the phone app calls core's: `x-hfos-client: extension`, its build in
`x-hfos-app-version` (held to `MIN_EXTENSION_VERSION` on the API when that's set), and a command id and moment on
every save, so a repeat gets the first answer and the audit log says "via browser extension".

## The owner's decisions

The owner answered the plan's questions on 5 Oct 2026. These are settled: ask before going against one.

1. **Sending is a setting, per person.** (a) They approve each one, the default; (b) likes and reactions happen on
   their own and they send the words; (c) fully hands-off, inside the daily limits. Every mode keeps the limits and
   stops for the day on any Facebook warning. In hands-off, a reply waits for the person unless "answer replies" is
   also on, and those replies follow the AI teammate's rules (`packages/core/src/ai-team/guardrails.ts`). The Chrome
   Web Store won't list an extension that sends without the user confirming, so hands-off lives only in a build
   loaded by hand.
2. **Old friends and chats come in either way:** Facebook's download file (the default), or "Collect from Facebook",
   where the extension scrolls the friends list and chats itself at a steady pace and stops on any warning.
3. **What goes in Contacts is a setting:** everyone, the tagged, or only likely prospects.
4. **The owner tests first,** loading the extension by hand. No store listing yet.
5. **Templates after CRM demos:** real estate agents, home services, then coaches.
6. **Only with the add-on.** The extension connects only to businesses where Social Outreach is on and the person
   has `outreach.use`. HandsFreeOS refuses it elsewhere, and it stops and says so when the add-on is turned off.

From the plan, not contested: it reads only pages the person opens; group admins and moderators are never approached;
"Not interested" ends outreach for good; drafts mention only what's really on someone's profile or posts; and the
starting daily limits per Facebook account are 20 friend requests, 15 first messages, 20 follow-ups, 15 comments, 40
likes and 1 post, half that for new or quiet accounts.

## Rules worth knowing before changing anything

- **Nothing is saved until the person presses a button.** Reading a page only looks things up.
- **A profile is known by its number or its username,** whichever its links show. Saved one way and seen the other,
  the two can't be matched automatically: a save offers the customers with the same name first (`sameName` in
  `outreach.lookup`, with `hasProfile`), and **It’s them** saves with that `personId`. Two profiles on one customer
  are fine.
- **A new customer from Facebook** is added through core's `person.create`, run inside the save, with source
  "Facebook" and texting consent unknown, so campaigns leave them alone. Duplicates by name aren't refused there: the
  extension offers same-named customers before it adds anyone.
- **Each teammate's chats are their own.** A chat is kept per person who saved it (`owner_user_id`), by the number in
  its link, so two teammates writing to the same customer keep two chats on that customer.
- **A chat saves to** the customer its profile link is saved to (or adds one), or the one picked, or the one it was
  saved with before; with none of those it's refused (`outreach_chat_without_profile`). Group chats can't be saved yet.
- **A chat keeps its latest 100 messages** (`KEPT_MESSAGES`). A read joins what was saved where the two overlap most
  (`joinMessages`), so scrolling up and saving again adds the older ones. Each message keeps when it was first saved,
  and the extension writes "Today" and "Wed 11:02 AM" as the date before sending (`apps/extension/src/hfos/when.ts`).
- **Limits live once,** in `limits.ts`. The commands hold sends to them; the extension cuts what it read to fit, and
  keeps a chat's save under the API's 256 KB.
- **Nobody deletes a saved profile, chat or playbook.** The tables' rules give no one delete; a playbook is archived
  instead, and two in use never share a name (`outreach_playbook_name_taken`). Their rows go when the business deletes
  the add-on's data, like any add-on's.
- **Timeline lines** come from `addonTimelineLine`: "added them from Facebook", "linked their Facebook profile",
  "saved 3 Facebook messages".
- **No real people in the repo.** Tests and fixtures use made-up names; the extension's readers are tuned from
  outlines, never saved pages (apps/extension/README.md).

## Not yet

The rest of Phase 1, in order: bringing in Facebook's download file with AI summaries and tags; groups, scored against
the playbook, with their members saved and admins and moderators skipped; the day's list (friend requests, openers,
follow-ups, comments), which the person sends and HandsFreeOS logs and counts against the limits; then leads, the demo
link, and results by group. The settings for decisions 1 to 3 arrive with the steps that need them.
