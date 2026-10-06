# Social Outreach

Social Outreach is an add-on (id `outreach`, in Sales) and a browser extension (`apps/extension`) that work beside a
person on Facebook, and later LinkedIn and Instagram. The extension reads the page they have open and notes the steps
they take there; the add-on keeps the people they find, their chats with them, what they've done, and the business's
playbooks in HandsFreeOS.

It's in `development`: offered to nobody, and installable only where HandsFreeOS staff hand it out to try
(docs/addon-architecture.md, "Handing one out to try").

## What's built

Phase 1, steps 1 and 2, the playbook builder, and tracking with the activity panel:

- **The activity panel** (`/a/outreach`, the page's first tab): what the extension noted over today, the last 7 days
  or the last 30. People reached, friend requests, likes, comments, chats started, follow-ups and who wrote back; by
  the group each person was found in, and person by person with how far each has come; and the person's own day
  against the daily limits. Owners and admins can see the whole team's (`?who=everyone`).
- **Noting what the person does on Facebook**: signed in, the extension notes each friend request, like, comment and
  message the person sends there themselves, with who it was to and the group they found them in, never what they
  wrote. Its side panel shows the day so far (apps/extension/README.md, "What it notes").
- **Playbooks** (`/a/outreach?view=playbooks`): what the business is looking for on social media, how it sounds and
  which of its tags to use. Each has a goal, an offer and link, who it's for, signs to look for and who to skip, where
  to look, the steps it takes and how fast, the tone, sample messages, the conversation, words to avoid, a disclaimer
  and the tags. The first template is **CRM demos**; a blank one is always there.
- **The playbook builder** (`/a/outreach/playbooks/new`, `/a/outreach/playbooks/<id>`): a playbook asked a step at a
  time, ten steps from the goal to a summary, each with ideas to tap and room for the business's own words. The offer
  step offers the business's booking pages as the link, and the tags step its own tags. A new playbook walks every
  step; changing one opens on the summary, where each part has its own Change.
- **The conversation**: the questions to work into a chat, each with the answers people give. An answer can add one of
  the playbook's tags, and says what's next: the next question, a question further down, the offer, checking back
  later, or stopping. A question with no answers is answered in the person's own words.
- **Saving from the extension**: signed in, the extension saves the Facebook profile or chat open beside it when the
  person presses its button, and marks the people and chats on any page that are saved already
  (apps/extension/README.md, "Signing in and saving").
- **A Social card on each customer** (`person.panels`): their Facebook profile, and each chat saved with them.

## How it fits together

| Piece                                                  | Where                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Manifest, operations, tables, shapes                   | `packages/core/src/addons/outreach/`                                             |
| What a save takes: lengths, counts, id shapes (no zod) | `packages/core/src/addons/outreach/limits.ts`                                    |
| Worker half: data version 2                            | `apps/worker/src/addons/outreach/`                                               |
| What the extension notes, and the panel's shapes       | `packages/core/src/addons/outreach/activity.ts`, `ops/activity.ts`               |
| The page: Activity and Playbooks tabs, the Social card | `apps/web/src/addons/outreach/`, `/a/outreach`                                   |
| The playbook builder                                   | `apps/web/src/addons/outreach/playbook-builder.tsx`, `/a/outreach/playbooks/…`   |
| Tables and permissions                                 | `supabase/migrations/20261024000100_addon_outreach.sql`, schema `addon_outreach` |
| Groups and steps noted                                 | `supabase/migrations/20261026000300_outreach_activity.sql`                       |
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
| `outreach.touch.save`                                 | `outreach.use`    | A step the person took on Facebook, as the extension saw it: to whom, and the group they came from   |
| `outreach.activity`                                   | `outreach.use`    | The panel's numbers over a stretch, by group and person, and the day; everyone's for owners, admins  |

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

The owner answered the next round on 6 Oct 2026 (plan.md, "Next: what you asked for on 6 Oct"). These are settled too:

7. **An activity panel in both places:** the full view on the Social Outreach page, today's numbers in the
   extension's side panel. Requests sent and from which group, likes, comments, chats started, replies. Built.
8. **The extension notes what the person does on Facebook themselves:** Add friend, Like, Comment and Send, with the
   group they found the person in. It replaces "nothing is saved until the person presses a button" for those four
   steps. Built.
9. **Playbooks are asked, not filled in,** and have a conversation where each answer adds a tag and picks what's
   next. Built.
10. **Unfriending is a setting:** suggestions confirmed one by one (the default), or on its own within a daily limit
    in the build loaded by hand.
11. **Don't pitch stops everything:** friend requests, likes, comments and messages.
12. **Sent requests nobody answers are cancelled after 3 weeks, with the person's OK.** The wait is a setting.
13. **The order:** the playbook builder, then tracking and the activity panel, then friends (requests received, the
    friends list, Keep and Don't pitch).

From the plan, not contested: it reads only pages the person opens; group admins and moderators are never approached;
"Not interested" ends outreach for good; drafts mention only what's really on someone's profile or posts; and the
starting daily limits per Facebook account are 20 friend requests, 15 first messages, 20 follow-ups, 15 comments, 40
likes and 1 post, half that for new or quiet accounts.

## Rules worth knowing before changing anything

- **Nothing is saved until the person presses a button,** except the four steps the extension notes (decision 8).
  Reading a page only looks things up.
- **Noting a step adds nobody to Contacts.** Someone reached is kept as a profile with no customer, and the group
  they were first found in, until the person saves them; saving keeps their steps. A friend request marks the profile
  "request sent".
- **A step counts once.** The same post liked again, or another friend request to them within a day, comes back
  `repeated` and isn't counted again; comments and messages each count. A step that waited in the extension keeps
  the moment it was taken (`offline: 'anytime'`), and the extension sends it again with the same command id.
- **A message's place is worked out as it's noted** (`messageStep`): the first to someone starts a chat, the first on
  a later day follows up, and the rest of a day's, and answers, are neither. The daily limits count only those.
- **The limits count, they don't stop.** The person takes these steps on Facebook themselves, so the panel and the
  extension warn past a limit (`pastLimitWords`) and nothing is refused.
- **Each person's steps are their own** (`user_id`). Owners and admins can see everyone's; anyone else asking is
  refused (`outreach_activity_everyone`), and the page shows them their own.
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
- **A playbook is checked by one schema,** `PlaybookDetails` (`playbooks.ts`): the builder checks each step with it
  as it's written, and the save holds to it. How long each part may be is `PLAYBOOK_LIMITS`, which the builder's boxes
  use too.
- **An answer only leads down.** It goes to a question further down or ends the questions, never back up, so a
  conversation can't go round in circles. It adds only one of the playbook's own tags (whatever the capitals), and the
  builder takes a tag off the answers when it comes off the playbook.
- **Questions are named q1, q2… in the order they're asked.** Answers point at those names, and a save renames them
  in order (`renumberQuestions`), with every answer still leading where it did.
- **Data version 2:** a playbook's questions became questions with answers, and it got a pace. Reading one saved
  before then gives it in today's shape (`upgradePlaybookDetails`, in `outreach.playbook.list`), because a business
  with the add-on on never runs a data step; the worker's step 2 tidies what a reinstall brings back.
- **Timeline lines** come from `addonTimelineLine`: "added them from Facebook", "linked their Facebook profile",
  "saved 3 Facebook messages".
- **No real people in the repo.** Tests and fixtures use made-up names; the extension's readers are tuned from
  outlines, never saved pages (apps/extension/README.md).

## Not yet

Next, in the owner's order: friends (requests received, the friends list, Keep, Don't pitch, cancelling old requests
and unfriending). The AI suggesting a conversation from the rest of the playbook comes with AI drafting.

The rest of Phase 1, in order: bringing in Facebook's download file with AI summaries and tags; groups, scored against
the playbook, with their members saved and admins and moderators skipped; the day's list (friend requests, openers,
follow-ups, comments), which the person sends and HandsFreeOS logs and counts against the limits; then leads, the demo
link, and results by group. The settings for decisions 1 to 3 arrive with the steps that need them.
