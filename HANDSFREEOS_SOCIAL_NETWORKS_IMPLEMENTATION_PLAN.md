# More networks for Social Outreach: LinkedIn first

Social Outreach works on Facebook only. This plan opens it to more networks: **LinkedIn first**, then Instagram,
Alignable, Threads, X and TikTok, and others later. It builds the groundwork once, so each new network is a kit that
plugs in, not a copy of the add-on, and each network runs on its own: what happens on one never stops, slows or
holds another.

**Where it stands (2026-10-15):** every question is answered (Chris, below), and nothing here is built yet. Step 1,
the groundwork in core, is next. Decision 34 in docs/outreach.md already put "LinkedIn then
Instagram" last in the add-on's order; this plan picks that up. Social Outreach is still in `development`.

## Decisions (Chris, 2026-10-15)

| Question                        | Answer                                                                                                                                                                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each network on its own         | **A warning or a pause on one network never affects the others.** Each has its own day, limits, warnings, training wheels, asks and line of work. See "Each network on its own" below.                                                                                       |
| What it does on its own         | **The same choices as Facebook** (decision 26), set for each network, off to start, inside that network's limits.                                                                                                                                                            |
| LinkedIn's invitations          | **No note.** The warm-up (a look at their profile, a like, a comment on a post about their work) does the work a note would.                                                                                                                                                 |
| Playbooks across networks       | **One playbook for all networks,** with a step that says which networks it works on and where to look on each (groups on Facebook, post search on LinkedIn). The niche, offer, conversation and voice are the same everywhere.                                               |
| The order                       | **LinkedIn, then Instagram, Alignable, Threads, X, and TikTok last.**                                                                                                                                                                                                        |
| One add-on                      | Follows from one playbook for all networks: networks are part of Social Outreach, since add-ons can't share data.                                                                                                                                                            |
| Who turns a network on          | **Each person,** in My settings, inside what the business allows (as the "on its own" choices, decision 38).                                                                                                                                                                 |
| The same person on two networks | **Don't pitch and Never contact cover all their profiles.** Once two profiles are on the same customer, putting either on a list covers both, and someone pitched or booked on one network isn't started again on another. Nothing is matched across networks by name alone. |
| Goals                           | **One monthly goal and one set of daily targets,** with Results showing each network's share.                                                                                                                                                                                |
| InMail and Sales Navigator      | **Later,** once LinkedIn works for free accounts.                                                                                                                                                                                                                            |
| LinkedIn's starting limits      | **As proposed** under "Starting daily limits".                                                                                                                                                                                                                               |
| The extension                   | **One extension, "HandsFreeOS Social", loaded by hand, never on the Chrome Web Store.**                                                                                                                                                                                      |

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
  offer, numbers and messages, how asks and live status work, computers, and the extension's sign-in, beat and
  panel. Each network still keeps its own day, limits and warnings (below).
- **A kit per network**, the same shape for each:
  - **In core** (`packages/core/src/addons/outreach/networks/<id>.ts`): its name; its steps and what they're called
    there ("Friend request" or "Invitation to connect"); its starting daily limits and any weekly cap; what a warning
    does; its kinds of ask; what Get ready checks on the person's profile and how long each part may be; the shape of
    its ids; where its people are found.
  - **In the worker**: the words its prompts use, so the AI hears "LinkedIn connection", never "Facebook friend".
  - **In the extension** (`apps/extension/src/networks/<id>/`): its addresses, its readers, the steps the person
    takes there (noting), the presses the runner makes, and its jobs. `src/facebook/` moves in as the first kit.
- **Each person turns networks on** in My settings, inside what the business allows in Business settings (since
  decision 73, On for you and Your team may use it, on the network's own page in Settings). A network that's off runs
  nothing, reads nothing and shows nothing.
- **Each network runs on its own** (Chris's rule, below).
- **The same person on two networks** is two profiles, and one customer once they're in Contacts (already allowed:
  "Two profiles on one customer are fine"). Nothing is matched across networks by name alone.

## Each network on its own

Chris's rule: a warning or a pause on one network never affects the others. So everything that stops, slows or holds
the work is kept for each network, each person:

- **The day.** Start my day and Stop for today are each network's. Today's strip shows each network the person has
  on, with its state, its next step and its own Start or Stop; **Start all** and **Stop all** just press each one.
  Stopping LinkedIn leaves Facebook going.
- **Warnings.** A LinkedIn warning stops LinkedIn for the rest of the day, halves its limits for 7 days and takes its
  invitations off the list for 2 (decision 25's rule, for that network). Facebook's day, limits and list don't move.
  The red note and the warning's push name the network, once a day each.
- **Limits.** Each network counts its own steps against its own limits, and a new or small account is halved on that
  network only.
- **Training wheels.** Each network's, since the choices of what it does on its own are each network's. A warning on
  one puts back only that network's.
- **Get ready.** The main offer, the playbook's niche, the goal and the messages are shared. The profile is each
  network's: a LinkedIn profile not checked yet holds back LinkedIn, never Facebook.
- **Lists first** (decision 60). Each network's first lists hold back only its own first day.
- **Asks and the once-a-day jobs.** An ask is refused, stopped or ended only for its own network's reasons. A job that
  fails on one network doesn't stop the next network's.
- **The work itself.** Each network has its own line and its own work window. A step handed to the person on
  LinkedIn (waiting for **Carry on**) holds only LinkedIn's line; Facebook's runner goes on beside it. Each line keeps
  its own pace, at its own random times.
- **The extension's own record.** It keeps each network's warnings (`hfos.warned`) and state apart, so a warning it
  sees on LinkedIn stops LinkedIn even when HandsFreeOS can't be reached, and nothing else.

What stays the person's, for all their networks: the working hours, the voice, the pushes setting, the morning push and
the day's report, the monthly goal, Needs you (one list, each item marked with its network), and the one computer that
works (decision 41).

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
  training wheels, lists, the profile check and the day get the network in the key, or a map by network inside the
  row (Chris's rule: each network's day is its own).
- **Asks have no network.** Their open-ask key is the kind and a target that's often empty (`''`, `'best'`), so a
  LinkedIn ask and a Facebook one of the same kind would answer each other. Asks get a `platform` column, in the key.

### The rules

- **Daily counts are per person, not per network.** `ops/today.ts` counts `touches` by person alone, and Today takes
  a `platform` it then ignores. LinkedIn's steps would use up Facebook's limits. The counts, the limits
  (`DAILY_LIMITS`, the business's `dailyLimits`, each person's settings) and `pastLimitWords` all go by network, each
  kit giving its starting numbers. LinkedIn's weekly invitation cap adds a rolling 7-day count beside the daily one.
- **A warning stops everything.** `warningOf` and `warnedToday` ignore the network the warning has; a warning halves
  every limit, stops the day (`days.why = 'warning'`) and puts training wheels back on, and the extension's
  `hfos.warned` is one for all. Each of these becomes the network's (above, "Each network on its own").
- **One runner, one turn.** The extension has one runner, one work window and one turn shared by asks and the runner
  (`auto/turns.ts`), so a step waiting for the person holds everything. Each network gets its own line: its own
  runner state, window and turn. The computer that works stays one per person (decision 41).
- **The same human on two networks** has two profiles, so two stages, two conversations and two pitches. Don't pitch
  and Never contact don't cross networks; only the Friend or family tag on a customer does. Chris's answer: they cover
  every profile on the same customer, and someone pitched or booked on one network isn't started on another, so
  `pitchable`, `contactable` and Today's picks look across the customer's profiles.
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
| Friend request                 | Invitation to connect, without a note (Chris)                                                                          |
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
video, the link, and follow-ups until they answer. What's different: the invitation goes without a note, and the first message goes only
after they accept, since LinkedIn won't let the person message anyone else.

### Where the people are

1. **Their own connections** who fit (decision 46's checks): the first place, as on Facebook.
2. **People who engage with the person's posts** (decision 50's warm leads): LinkedIn's strongest. The helpful post
   goes on their own feed.
3. **Posts asking for what the business offers** (decision 49): LinkedIn's post search with the playbook's signs
   ("looking for a…", "can anyone recommend…"), sorted by latest, looked at every hour or two in working hours.
4. **People search** by title, industry and place, 2nd-degree first. A free account hits a monthly search limit, so
   this goes lightly. Sales Navigator later.
5. **Groups**, checked as Facebook's (decision 48), but most are quiet.

### Starting daily limits

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
Facebook's does (decision 25), and touches nothing on Facebook.

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

## Build order

1. **Groundwork in core:** the network domain, looser id checks, the general steps and follow states, `platform` on
   asks and in the per-person keys; the day, counts, limits, warnings, training wheels and Get ready's profile by
   network; Don't pitch, Never contact and "pitched once" across a customer's profiles; and the prompts and words
   taking the network's. Facebook behaves as before, but for one thing: a customer's two Facebook profiles (number
   and username) are now both covered when either is on Don't pitch or Never contact. Every other test passes
   unchanged.
   New tests hold Chris's rule with a second, made-up network: a warning, a stop, a profile not ready, a first day
   waiting on lists and a step handed to the person on one each leave the other's day, limits, Today and asks as
   they were.
2. **Groundwork in the extension:** `src/networks/` with the kit's shape, Facebook moved in, optional host
   permissions, `workUrl` per kit, a line per network (runner state, window, turn, warnings), the jobs taking a
   network. Same behavior; the extension's tests pass
   unchanged.
3. **Networks in the app:** turning them on, Today's strip with each network's own Start and Stop, the network on
   every row, Results by network, the playbook's networks step, setup's step. Only Facebook to pick yet.
4. **LinkedIn, parts 1 to 6** above, one PR each (decision 35's way).
5. **The owner tries LinkedIn** on their own account; the readers are tuned from outlines.
6. **The next networks**, in Chris's order: Instagram, Alignable, Threads, X, then TikTok. Each starts with a look
   at a real account and a kit.

Each step's migration goes on the hosted database before `main` (CLAUDE.md, "Database migrations").

## The owner's LinkedIn test

Build order step 5. LinkedIn's parts 1 to 6 are in (extension 0.43.0; since 0.44.0 the extension's panel shows
progress and activity only, decision 72 in docs/outreach.md). Try it on your own LinkedIn account. What needs you,
the messages to OK with their chats and a step handed to you among them, is under Needs you on Today in HandsFreeOS,
on the web or the phone: press **Carry on** there once you've done a step. Where a page reads wrong, or a step is
handed to you, also send the page's outline (**Copy page outline**, at the foot of the panel). It never holds a name
or a message, and the readers are tuned from it.

### Get set up

1. **Update the extension.** Download it again from Social Outreach → Settings → Your computer, unzip it over the
   same folder, and press the reload arrow on its card in `chrome://extensions`. The card shows 0.54.0.
2. **Check the business allows LinkedIn.** Social Outreach → Settings → LinkedIn, under For your team on LinkedIn:
   **Your team may use LinkedIn** is on, as it is to start. A business allows every network unless an owner or admin
   turns one off there. Its daily limits for each person are below it, and start at the ones below.
3. **Turn LinkedIn on for you.** On the same page, switch **On for you** on, beside LinkedIn's name. It saves at once,
   and the line beside it says so (Chris, 2026-10-16). Its choices start off, and each saves as you pick it (decision
   73). Leave them off, or turn on only the first ones, for the first day.
4. **Let the extension on LinkedIn.** Open the panel, press **Allow on LinkedIn**, then **Allow** in Chrome's box.
   Reload any LinkedIn tab that was open before.
5. **Get ready on LinkedIn.** On Today, pick LinkedIn's row. Under Get ready, press **Read my profile**, then:
   - tick what's right;
   - pick a headline and press **Put this one in**;
   - copy the About to start from and make it yours.

### What to try, and what to check

| Try                                                      | Check                                                                                                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read my profile                                          | `/in/me/` reads as your own profile, with its headline, About, Experience, Featured and Activity                                                    |
| Put this one in                                          | Edit intro opens, only the Headline field changes, and it's saved                                                                                   |
| Connect with someone yourself, with a note and without   | It's noted once it goes (the box's Send, or the button turning to Pending), and never when you cancel                                               |
| Like, comment and send a message yourself                | Each is noted once. Enter in a comment box counts only once the box empties                                                                         |
| Someone writes back                                      | They show under Needs you in HandsFreeOS, and on LinkedIn's Today as a reply                                                                        |
| Save my connections, Check my invitations                | The scrolling and LinkedIn's "Show more results" work, and the counts match LinkedIn's                                                              |
| Check my connections for good fits                       | One profile page at a time, at most 40 a day                                                                                                        |
| Read my chats                                            | Conversations open from messaging's list                                                                                                            |
| Find posts                                               | Post search shows recent posts, and the ones asking for what you offer come to Today to comment on                                                  |
| Withdraw old invitations (Friends, narrowed to LinkedIn) | The words on Sent invitations and in the withdraw box are read right                                                                                |
| Ask LinkedIn for your data                               | On "Get a copy of your data", the choice and its four boxes are picked, it hands over for your password, and "being prepared" is seen               |
| Download it, then bring it in                            | Chrome names the zip `…LinkedInDataExport…`; your connections, invitations and chats arrive; old sent invitations show to withdraw                  |
| Start my day on LinkedIn                                 | With your choices on, it looks and likes, connects without a note, comments, and sends only what you OK'd in HandsFreeOS, slowly, in its own window |
| The helpful post                                         | Start a post opens a box it can type into, "View post" gives its link, and whoever reacts or comments shows on LinkedIn's Today                     |
| Both networks at once                                    | A Facebook ask and a LinkedIn ask go side by side, and a LinkedIn warning stops only LinkedIn                                                       |

LinkedIn's limits to start: 15 invitations a day and never more than 80 in 7 days, 15 first messages, 20 follow-ups,
10 comments, 30 likes, 40 profiles read, 1 post and 20 invitations withdrawn. A LinkedIn warning halves them for 7
days and stops invitations for 2, on LinkedIn only.

The pages' words (the data page's "being prepared" line, its boxes, Start a post) are a best reading of LinkedIn's
pages until this test. Where they differ, the step goes to you with its outline rather than failing quietly.

What the test found so far (16 Oct 2026): LinkedIn shows its newer layout (plain text, `data-testid`s, posts as list
items, a reaction button labelled by its state, never "React Like"), so a like he gave wasn't noted and his own
profile was misread; and LinkedIn draws a profile's lower parts only as they scroll into view. 0.45.0 scrolls the
profile to its foot before reading it; 0.46.0 reads the feed, likes, comments and his profile from his two outlines
(the extension's README says what it still guesses). Its first read on 0.46.0 still had nothing below Activity, and
took the About for a post: Chrome draws nothing in a window hidden behind another, so 0.47.0 brings the window to the
front while it reads, then his own back, and never reads past the section above Activity. Its read on 0.47.0 still
had no Experience, and the headline's pencil wasn't found. So 0.48.0 reports for itself (decision 74): each read of
the profile, each step handed over and each one that didn't go is noted with its page's outline, and **Check
LinkedIn** on LinkedIn's page in Settings reads the main pages in one press. From 0.49.0 those notes are problem
reports on HandsFreeOS's support desk (`/admin/problems`, decision 75), for every network. His first Check LinkedIn
(17 Oct 2026) showed why Experience was never read: below Activity, LinkedIn's newer layout leaves empty places it
fills only a moment after each is seen, and the read came first; and the pencil's label isn't "Edit intro" any more.
So 0.50.0 keeps each empty place in view till it's drawn, and finds the pencil by its link to the intro's box. His
Put this one in on 0.50.0 pressed the pencil (it says "Edit profile"), but the box's Headline is now a writing box
named by the line above it, not by a label, so 0.51.0 names a field by the words just above it when nothing else
does. His Put this one in on 0.51.0 still didn't put it in, and its report couldn't say which step failed. So 0.52.0's
says (the box's fields, as the outline names them), looks a little further up for a field's name, and pastes the
words when typing doesn't take; and **Check LinkedIn** now tries every step up to its last press, so one press finds
all that doesn't work rather than one step at a time (decision 76). Its first run found the headline's field still
unnamed (it sits deeper than the extension looked), Message opening nothing the page could see (LinkedIn's newer pages
draw their older parts in an interop box out of the page's reach), and a "1st" beside the real "2nd" on someone with
Connect; 0.53.0 fixes the three, looks inside the interop box, and outlines it. On 0.53.0 every step worked but
messaging: Message opens the new conversation's own page in the interop frame, whose Send stays off till something's
written; 0.54.0 counts a Send that's still off and writes on that page. The
outlines are no longer pasted. Outlines that would settle the rest: a post with words typed in
its comment box, post search results and a post's own page, someone else's profile, a conversation with words typed,
and a post with the reactions menu open.
