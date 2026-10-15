# More networks for Social Outreach: LinkedIn first

Social Outreach works on Facebook only. This plan opens it to more networks: **LinkedIn first**, then Instagram,
Threads, X, TikTok and Alignable, and others later. It builds the groundwork once, so each new network is a kit that
plugs in, not a copy of the add-on.

**Where it stands (2026-10-15):** a draft. Nothing here is built. The questions at the end need Chris's answers
before step 1. Decision 34 in docs/outreach.md already put "LinkedIn then Instagram" last in the add-on's order;
this plan picks that up. Social Outreach is still in `development`.

## What each network is like

What matters for outreach on each, as of October 2026. LinkedIn's numbers are what sellers see, not what LinkedIn
publishes, and they move with the account's age and health. Rows marked _to check_ need a look on a real account.

| Network   | How you connect                                                                                                      | Who you can message                                       | Where the people are                                                                | Download file                                                       | An API for this?                                                                                 | Risk to the person's account                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Facebook  | Friend request; 5,000 friends                                                                                        | Anyone; strangers land in Message Requests                | Groups and their posts                                                              | Yes (built)                                                         | No: Messenger's API is for Pages, and only answers                                               | Medium: warnings and short blocks                                                         |
| LinkedIn  | Invitation to connect, about 100 a week on a rolling 7 days; a note of 200 characters (about 5 a month free); 30,000 | 1st-degree connections; anyone else only by InMail (paid) | Search (people and posts), the person's own feed, their connections, groups (quiet) | Yes: "Get a copy of your data" (Connections, Invitations, messages) | No: its APIs are for partners and don't do outreach                                              | **High**: its terms forbid automating, and its pages check which extensions a browser has |
| Instagram | Follow (a request when private)                                                                                      | Anyone; non-followers land in Requests                    | Hashtags, places, other accounts' followers and commenters                          | Yes                                                                 | Only to answer people who wrote first to a professional account, which core's inbox does already | High: "Action blocked" comes fast                                                         |
| Threads   | Follow                                                                                                               | By their setting; DMs on the web since May 2026           | Topics and search                                                                   | With Instagram's                                                    | Posting and replies, no DMs                                                                      | Medium                                                                                    |
| X         | Follow                                                                                                               | Often only people they follow, or verified accounts       | Search (live, and good for "anyone recommend…"), lists, communities                 | Yes (archive)                                                       | Paid                                                                                             | Medium to high                                                                            |
| TikTok    | Follow                                                                                                               | Only mutual follows, 16 and over                          | Hashtags, search, comments                                                          | Yes                                                                 | No DMs                                                                                           | High: strong bot checks                                                                   |
| Alignable | Connect (an invitation); recommend                                                                                   | Connections _to check_                                    | Local communities, industries, its Q&A forum                                        | _to check_                                                          | None                                                                                             | _to check_; a small site, little published                                                |

What this says: LinkedIn and Alignable fit the way Social Outreach works now (connect, warm up, message, follow up),
because both are made for business. Instagram, Threads, X and TikTok are follow networks: no friend list to work,
messages often closed to strangers, and posts and comments do the warming up. TikTok fits the model least.

## How it fits: one add-on, a kit per network

- **One add-on.** Networks are part of Social Outreach, never add-ons of their own: add-ons never touch each other's
  data, so separate ones couldn't share playbooks, the Pipeline, Needs you or the numbers.
- **Shared, with no network in it:** playbooks (the niche, the offer, the conversation, the voice), Today, Needs you,
  messages waiting (`sends`), stages, follow-ups (`follow_ups`), the numbers and the week's review, Get ready's main
  offer, numbers and messages, asks, live status, computers, and the extension's sign-in, beat and panel.
- **A kit per network**, the same shape for each:
  - **In core** (`packages/core/src/addons/outreach/networks/<id>.ts`): its name; its steps and what they're called
    there ("Friend request" or "Invitation to connect"); its starting daily limits and any weekly cap; what a warning
    does; its kinds of ask; what Get ready checks on the person's profile and how long each part may be; the shape of
    its ids; where its people are found.
  - **In the worker**: the words its prompts use, so the AI hears "LinkedIn connection", never "Facebook friend".
  - **In the extension** (`apps/extension/src/networks/<id>/`): its addresses, its readers, the steps the person
    takes there (noting), the presses the runner makes, and its jobs. `src/facebook/` moves in as the first kit.
- **Each person turns networks on** in My settings, inside what the business allows in Business settings. A network
  that's off runs nothing, reads nothing and shows nothing.
- **One working computer still** (decision 41). Its runner works all of the person's networks, one step at a time,
  taking turns, as asks and the runner take turns now.
- **Limits and warnings are per network.** A warning on LinkedIn stops LinkedIn for the day and halves its limits for
  7 days; Facebook carries on. Training wheels stay per person: they're about trusting the AI's messages, wherever
  they go.
- **The same person on two networks** is two profiles, and one customer once they're in Contacts (already allowed:
  "Two profiles on one customer are fine"). Nothing is matched across networks by name alone.

## What has to change first: the groundwork

A thin layer is ready: `PLATFORMS` in `playbooks.ts`, saves that take a `platform` (defaulting to Facebook), profile
and group look-ups by network, a customer's source ("Facebook" from `sourceFor`), the Social card, Don't pitch's
twins matched per network, and a playbook's `details.platforms`, which the builder shows as Facebook only. Everything
above that assumes Facebook: the rules, the words, the AI's prompts, the settings and the whole extension. Nothing
picks a network anywhere.

The groundwork makes the network explicit, with no change to what Facebook users see.

### The data

- **Seven tables carry `platform text check (platform in ('facebook'))`:** profiles, threads, groups, and the
  download file's imports, file_people and file_chats, and warnings. Their unique keys already hold the network. A
  domain (`addon_outreach.network`) replaces the seven checks, so a new network is one line in one migration. Drizzle
  mirrors it; if the parity test can't, we keep writing the checks out.
- **Seventeen take it from the profile or group they point at** (sends, stages, checks, follow-ups, opener uses,
  replies, demos, friends, friend ends, touches, needs, posts, engagements, group people, my groups, joins, helpful).
  They need nothing new, but every query that counts or picks from them must join to the network.
- **Ids are Facebook's shape.** A profile's `platform_id` is numbers only and its `username` letters, numbers and
  dots; a group's id and a reply's `thread_key` are numbers only (`limits.ts` mirrors them). LinkedIn's member ids look
  like `ACoAA…` and its addresses have hyphens; Instagram, X and TikTok names have underscores. Each kit gives its own
  shapes, checked in core, and the database checks loosen to "short, plain characters".
- **Friendship is two-way.** `profiles.friendship`, `mutual_friends` and `friends.state` know friends, requests and
  not friends. LinkedIn fits (connected, invited, not connected, plus how far: 1st, 2nd, 3rd). Instagram, Threads, X
  and TikTok need following and followed by, each way on its own. Add those states now, so the follow networks don't
  need the table changed again.
- **Steps are Facebook's.** `touches.kind` (friend request, like, comment, message), `needs.step`, `friend_ends.kind`
  (cancel, unfriend), `computers.doing` and `file_people.list`. They become general steps (connect, follow, like,
  comment, message, withdraw, remove), each kit saying which it has and what it calls them.
- **One row a person, with no network:** `automation` (its columns are Facebook choices: like first, confirm
  requests, join groups, tidying), `list_saves`, `setup` (the profile check and its ticks) and `days`. Settings,
  lists and the profile check get the network in the key, or a map by network inside the row. `days` stays one a
  person: one Start my day for all their networks.
- **Asks have no network.** Their open-ask key is the kind and a target that's often empty (`''`, `'best'`), so a
  LinkedIn ask and a Facebook one of the same kind would answer each other. Asks get a `platform` column, in the key.

### The rules

- **Daily counts are per person, not per network.** `ops/today.ts` counts `touches` by person alone, and Today takes
  a `platform` it then ignores. LinkedIn's steps would use up Facebook's limits. The counts, the limits
  (`DAILY_LIMITS`, the business's `dailyLimits`, each person's settings) and `pastLimitWords` all go by network, each
  kit giving its starting numbers. LinkedIn's weekly invitation cap adds a rolling 7-day count beside the daily one.
- **A warning stops everything.** `warningOf` and `warnedToday` ignore the network the warning has; a warning halves
  every limit, stops the day and puts training wheels back on, and the extension's `hfos.warned` is one for all. A
  warning becomes the network's: that network's limits halve and its steps and asks stop for the day; the others go
  on. Training wheels still come back, since they're the person's.
- **One computer, one turn.** One working computer, one runner and one turn for asks (`auto/turns.ts`) stay: every
  network's steps go through the same line, one at a time, which also keeps each network's pace natural.
- **The same human on two networks** has two profiles, so two stages, two conversations and two pitches. Don't pitch
  and Never contact don't cross networks; only the Friend or family tag on a customer does. See question 6.
- **Facebook-only links.** `FacebookUrl` (`saves.ts`) checks links in saves, steps, posts, tidying, needs and the
  web's and phone's Needs you. It becomes a check by network.

### Words and the AI

- **The prompts live in core** and the worker imports them: 14 of 15 say Facebook (only the niche fit doesn't). Each
  takes the network's words from its kit: "connection" or "friend", "LinkedIn messaging" or "Messenger".
- **About 280 strings** on screens say Facebook (about 150 in core's words and prompts, 40 on the web, 15 on the
  phone, 70 in the extension), with about 75 "friend request" and 15 "Messenger". Each becomes the network's word or
  a word for all of them ("connected", "your networks").
- **Today, People and Results** show the network on every row as its name, never a logo we don't have the right to
  use. Long lists filter by network, and Results add "by network" beside "by playbook" and "by offer version".
- **Two lists of networks.** Core's messaging has its own `MetaPlatform` (`facebook`, `instagram`, in
  `messaging/social.ts`). They stay apart: one is the business's Pages, the other a person's own accounts.

### The extension

- **Only Facebook's sites.** The manifest's host permissions and content scripts, `workUrl`, the background (which
  takes notes only from Facebook tabs), `content.ts` (which dispatches to 15 Facebook readers), `messages.ts`'s
  types, and `'facebook'` written out in `hfos/saves.ts`, `hfos/warned.ts`, `jobs/chats.ts`, `jobs/tidy.ts` and
  `auto/run.ts`.
- **Already neutral:** sign-in, the beat, asks, following settings, Needs you, the prompt, setup, the panel, the
  turns, `auto/plan.ts`'s timing, the `Job` and `JobTab` shapes, the noting queue and `WorkTab` (but for `workUrl`).
- **Worth lifting out:** button plans as data (`FETCH_PLANS`, `TIDY_PLANS`, `AUTO_PLANS`), run by `doStep` and
  `doPath` in `facebook/fetch.ts`. That engine is the same on any site.
- **What a kit gives the extension**, from how `src/facebook/` is used now: its addresses (what kind of page, the
  person, group, chat or post a link points at, its work hosts); `readPage` and its readers (profile, people, groups,
  posts, chat, warnings); noting (a click or Enter that was a step, an answer to a request); spotting replies and
  looking as the person goes; browsing (open a chat, scroll a list); its button plans; the runner's presses (read
  their posts, like one, comment, write a message, check it's the same person); compose, join and look-up; its own
  profile; its words (English for now), its times and the outline.
- **New sites, asked for when turned on.** Each network's sites go in optional host permissions, asked the first time
  the person turns that network on, so the extension never runs on a site they don't use. Adding them as required
  permissions would make Chrome ask everyone again on update.
- **Facebook moves in first.** `src/facebook/` becomes `src/networks/facebook/` behind the kit's shape, with its
  tests unchanged.

## LinkedIn

### What maps to what

| On Facebook                    | On LinkedIn                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Friend request                 | Invitation to connect, without a note to start (free accounts get only a few notes a month)                            |
| Friends (5,000)                | 1st-degree connections (30,000), and how far each is from the person: 1st, 2nd or 3rd                                  |
| Friend requests got and sent   | Invitations received and sent (My Network → Manage invitations)                                                        |
| Cancel an old request          | Withdraw an invitation (LinkedIn caps how many can wait, so this matters more here)                                    |
| Unfriend                       | Remove connection: not offered; nobody needs to tidy a LinkedIn network for room                                       |
| Mutual friends                 | Mutual connections                                                                                                     |
| Groups and their posts         | Post search by the playbook's words, latest first; the person's feed; groups, checked like Facebook's but weighted low |
| A helpful post in a group      | A post on the person's own feed, which reaches their connections and followers                                         |
| Messenger                      | LinkedIn messaging, 1st-degree only (InMail later, if ever)                                                            |
| Like, comment                  | React (Like), comment                                                                                                  |
| Facebook's download file       | "Get a copy of your data": Connections, Invitations and messages                                                       |
| Get ready's profile: bio (101) | Headline (220), About (2,600), Featured; photo and banner as tips                                                      |
| Facebook's warnings            | The weekly invitation limit, "your account is restricted", a security check, the search limit for free accounts        |

**A look at a profile is seen.** LinkedIn tells people who viewed them (unless the viewer browses privately). A check
(decision 46) or a look-up before drafting shows up as a view. That's a warm-up in itself, and it means reading
profiles counts as reaching someone: it has a daily limit of its own on LinkedIn.

### The conversation

The same as on Facebook since the main offer's plan (decisions 65 to 67): warm up (view their profile, like a post,
a short comment when their post is about their work), connect, then the direct first message once they accept, the
video, the link, and follow-ups until they answer. What's different: the invitation goes without a note unless the
person has notes left and turns them on, and the first message goes only after they accept, since LinkedIn won't let
the person message anyone else.

### Where the people are

1. **Their own connections** who fit (decision 46's checks): the first place, as on Facebook.
2. **People who engage with the person's posts** (decision 50's warm leads): LinkedIn's strongest. The helpful post
   goes on their own feed.
3. **Posts asking for what the business offers** (decision 49): LinkedIn's post search with the playbook's signs
   ("looking for a…", "can anyone recommend…"), sorted by latest, looked at every hour or two in working hours.
4. **People search** by title, industry and place, 2nd-degree first. A free account hits a monthly search limit, so
   this goes lightly. Sales Navigator later.
5. **Groups**, checked as Facebook's (decision 48), but most are quiet.

### Starting daily limits (proposed)

| Step                                | A day | Also                                                     |
| ----------------------------------- | ----- | -------------------------------------------------------- |
| Invitations to connect              | 15    | Never more than 80 in a rolling 7 days                   |
| First messages                      | 15    |                                                          |
| Follow-ups, the video, the link     | 20    |                                                          |
| Comments                            | 10    |                                                          |
| Likes                               | 30    |                                                          |
| Profiles read (checks and look-ups) | 40    | They're seen                                             |
| Posts                               | 1     |                                                          |
| Invitations withdrawn               | 20    | After 3 weeks waiting (decision 12's wait), oldest first |

Half for a new or small account. A LinkedIn warning halves them for 7 days and stops invitations for 2, as
Facebook's does (decision 25).

### The risk, said plainly

LinkedIn's User Agreement forbids software that automates activity on it or copies from it. Its pages check which
extensions a browser has (the "BrowserGate" report of April 2026, which BleepingComputer confirmed), and it restricts
accounts it thinks are automated. For someone who sells to businesses, a restricted LinkedIn account costs more than
a Facebook block.

So on LinkedIn:

- The person's own steps are noted, as on Facebook. That adds no risk: they're pressing the buttons.
- Reading (their lists, their file, checks, look-ups) goes at a person's pace, in its own window, and stops on any
  warning.
- What the extension does on its own is the person's choice, off to start, at LinkedIn's lower limits. Messages wait
  for an OK, as now.
- The owner tries it on their own account first (as decision 4), and the readers are tuned from outlines, never saved
  pages.
- We build nothing to get around LinkedIn's limits or its checks.

### LinkedIn, part by part

1. **Reading.** Its addresses and readers: a profile, connections, invitations both ways, search results (people
   and posts), the feed and a post's comments and reactions, messaging's list and an open chat, notifications,
   warnings. Hand-written test pages, and again with bare boxes, as Facebook's.
2. **Noting the person's steps:** Connect (with or without a note), Accept and Ignore, Like, Comment, Send in
   messaging. Who wrote back, from messaging's list.
3. **In the app:** turning LinkedIn on; Today, People and Results with LinkedIn's rows; its limits in Settings; Get
   ready's profile check for the headline and About; the setup's step to pick networks.
4. **Asks:** save my connections, my invitations, get my LinkedIn file and bring it in, check my connections for good
   fits, read my chats, look someone up before drafting, read my profile and put the headline in.
5. **On its own:** view and like, connect, comment, send what's OK'd, withdraw old invitations; the once-a-day jobs;
   lists first (decision 60) for connections and invitations.
6. **Growing:** posts asking for what the business offers, from post search; the helpful post on their own feed; the
   people who engage with it as warm leads.

## The networks after LinkedIn

What each needs that LinkedIn won't have built:

- **Instagram.** A follow network: follow, like, comment, then a DM, which lands in Requests until they follow back.
  No groups: people are found by hashtags, places, and the followers and commenters of accounts like the business's.
  Core's inbox already gets DMs to the business's own Instagram professional account through Meta's API
  (docs/meta-messaging.md). When the person does outreach from that same account, the add-on hears those messages
  through core's events and must not count them twice. Instagram blocks fast, so its limits start low.
- **Threads.** Follow, like, reply; DMs on the web. Search by topic. Its API can post, so the helpful post could go
  through it later instead of the page.
- **X.** Follow, like, reply. Search is the best of the lot for "anyone recommend a…", live. DMs are often closed to
  strangers, so the reply under their post is usually the first step.
- **TikTok.** Follow, like, comment; DMs only once they follow back. The weakest fit: it's about videos, not
  conversations. Likely comments and profile visits only.
- **Alignable.** Made for small businesses, by town: connect, message, recommend, and a Q&A forum where owners ask
  for referrals. Close to LinkedIn in shape, and likely the best fit for local businesses. Little is published, so it
  starts with a look at a real account.

## Questions for Chris

Each has what I'd pick, and why.

1. **One add-on, with networks in it?** Recommend yes: shared playbooks, Pipeline and numbers, and add-ons can't
   share data with each other.
2. **Who turns a network on?** Recommend: each person in My settings, inside what the business allows, the same way
   the "on its own" choices work (decision 38).
3. **Playbooks across networks.** Recommend one playbook for all networks, with a step that says which networks it
   works on and where to look on each (groups on Facebook, post search on LinkedIn). The niche, offer, conversation
   and voice stay the same everywhere.
4. **How much LinkedIn does on its own.** (a) The same choices as Facebook (decision 26), set per network, off to
   start, at LinkedIn's lower limits; (b) LinkedIn only reads and drafts, and every step that reaches someone is the
   person's press or one tap. Recommend (a) with LinkedIn off to start, given the owner tries it first, since the
   person's choice already guards it. Say (b) if the account risk worries you more than the time saved.
5. **The invitation's note.** Recommend no note to start (free accounts get about 5 a month), warm up first instead,
   and a setting to add a note for people with notes to spare.
6. **The same person on two networks.** Today Don't pitch and Never contact cover one profile, and the same name on
   the same network, so someone on Facebook and LinkedIn could be pitched twice. Recommend: once two profiles are on
   the same customer, either list covers both, and someone pitched or booked on one network isn't started again on
   the other. Nothing is matched across networks by name alone.
7. **One goal or one per network?** Recommend one monthly goal and one set of daily targets, with Results showing
   each network's share.
8. **InMail and Sales Navigator.** Recommend later, after LinkedIn works for free accounts.
9. **The order after LinkedIn.** You named Instagram, Threads, X, TikTok and Alignable. Recommend Instagram, then
   Alignable (close to LinkedIn and made for small businesses), then Threads, X, and TikTok last.
10. **The daily limits above.** Fine to start, or different numbers?
11. **The extension's name and listing.** It stays one extension, "HandsFreeOS Social", loaded by hand. Recommend
    keeping it that way: a store listing would have to drop what it does on its own (decision 1), and LinkedIn's
    terms make a listing riskier still.

## Build order

1. **Groundwork in core:** the network domain, looser id checks, the general steps and follow states, `platform` on
   asks and in the per-person keys, counts, limits and warnings by network, and the prompts and words taking the
   network's. Facebook behaves as before; every test passes unchanged.
2. **Groundwork in the extension:** `src/networks/` with the kit's shape, Facebook moved in, optional host
   permissions, `workUrl` per kit, the runner and jobs taking a network. Same behavior; the extension's tests pass
   unchanged.
3. **Networks in the app:** turning them on, the network on every row, Results by network, setup's step. Only
   Facebook to pick yet.
4. **LinkedIn, parts 1 to 6** above, one PR each (decision 35's way).
5. **The owner tries LinkedIn** on their own account; the readers are tuned from outlines.
6. **The next network**, in the order question 9 settles, each starting with a look at a real account and a kit.

Each step's migration goes on the hosted database before `main` (CLAUDE.md, "Database migrations").
