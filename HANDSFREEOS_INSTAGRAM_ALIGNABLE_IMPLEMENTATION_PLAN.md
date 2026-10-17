# Finding customers on each network: Instagram and Alignable next

Chris (17 Oct 2026): "need to determine how we will do our social media lead generation marketing in instagram, and
alignable. Like what steps, what features, profile optimization, platform searches, comments, messages, likes and
reactions, posts etc. once we plan that out we can build out the web app changes and extension changes need. lets
also make sure we understand that process for facebook and linkedin as well."

**Where it stands (17 Oct 2026):** Facebook and LinkedIn work. "How it works today" below says how, in plain words,
with three gaps found while writing it. Instagram and Alignable can be turned on and checked (decision 78 in
docs/outreach.md), and their Checks now find every step's button on Chris's own accounts:

- Check Alignable found all 5 on extension 0.59.0.
- Check Instagram found 4 of 5 on 0.60.0. The fifth, the comment, is fixed in 0.61.0.

Nothing below is built yet. The questions come first, each with a recommendation. Once Chris answers, they become
this plan's decisions, and the build starts at step 1 of the build order.

The plan's earlier work is in HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md: one add-on, a kit per network, and
each network on its own.

## Questions for Chris

| #   | Question                                  | Recommendation                                                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Fix LinkedIn's three gaps first?          | **Yes.** People found by LinkedIn's post search should get invitations, and Settings shouldn't show switches LinkedIn can't do. The first fix is also what Instagram and Alignable need: people found by a search, not only in groups.                                                                               |
| 2   | Which network first?                      | **Alignable, then Instagram.** Your order of 15 Oct put Instagram first. But Alignable works like LinkedIn (connect, message, follow up), its Check found every button, it's made for local businesses, and its risk is lower. Instagram needs more new pieces: follow-backs, message requests, posts with pictures. |
| 3   | Which Instagram account?                  | **The business's professional account.** Its replies then also reach HandsFreeOS's inbox through Meta (docs/meta-messaging.md, built), and Instagram shows it contact buttons and a category. A personal account works too, without those.                                                                           |
| 4   | When does the first Instagram message go? | **Once they follow back, or answer your comment.** If they do neither within 3 days, send one short message with no link. Instagram passes only one text message to someone who doesn't follow you, until they accept it.                                                                                            |
| 5   | Unfollow on Instagram?                    | **Yes, slowly.** Unfollow people who didn't follow back within 3 weeks, at most 20 a day. Never someone who wrote back, a customer, or anyone you followed yourself. This keeps you well under Instagram's 7,500 cap.                                                                                                |
| 6   | Posts on Instagram?                       | **The AI drafts the caption and says what picture to use; you post it.** The extension can't choose your photos. Stories are tips only, to start.                                                                                                                                                                    |
| 7   | Who to look for on Alignable?             | **Each playbook says: customers, referral partners, or both.** Referral partners are businesses whose customers need you, such as a realtor for a home inspector. Alignable is built for referrals. With a partner, the call booked is one to swap referrals, on the same booking link.                              |
| 8   | Recommend on Alignable?                   | **Only by hand,** for a business you really know. Never on its own. A recommendation is your name vouching for them, and it often earns one back.                                                                                                                                                                    |
| 9   | Answer questions in Alignable's forum?    | **Yes, after your OK each time.** When someone asks for what you offer, the AI drafts a helpful answer and you OK it before it posts. It's public writing, so it always waits for you.                                                                                                                               |
| 10  | Starting daily limits?                    | **As in the tables below,** and half for a new or small account, as on the other networks.                                                                                                                                                                                                                           |

## The process, on one page

The same conversation runs on every network (decisions 65 to 67), so a playbook works everywhere:

1. Find people who fit.
2. Warm up.
3. Connect or follow.
4. Ask straight out.
5. Send the video, then the link.
6. Follow up until they answer.

What changes from network to network is where the people are and what each step is called.

| Step                         | Facebook (built)                                                                      | LinkedIn (built)                                                                                 | Instagram (proposed)                                                                                                 | Alignable (proposed)                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Your profile** (Get ready) | Picture, cover, bio (101), work, featured, posts. The extension writes the bio        | Picture, banner, headline (220), About, experience, featured, activity. It writes the headline   | Picture, name (searched), bio (150), links, highlights, pinned posts. It writes the bio                              | Logo or photo, cover, description, services, town, recommendations. It writes the description |
| **Where the people are**     | Your friends and chats, your groups and their members, posts asking for what you sell | Your connections, posts found by searching the playbook's words, people engaging with your posts | People engaging with you, your followers, local hashtags and places, followers and commenters of accounts like yours | Your connections, requests you got, your town's businesses, forum questions, groups, events   |
| **Warming up**               | Like a recent post, a short comment when it's about their work, a day before          | View their profile and like a post                                                               | Like 1 or 2 recent posts, a short comment on one about their work                                                    | Like or comment on their post or forum answer, view their profile                             |
| **Connecting**               | Friend request (20 a day)                                                             | Invitation, no note (15 a day, 80 a week)                                                        | Follow (20 a day)                                                                                                    | Connection request (15 a day)                                                                 |
| **First message**            | Once they accept: ask straight out                                                    | Once they accept: ask straight out                                                               | Once they follow back or answer; else one short message with no link after 3 days                                    | Once they accept: about them and referring each other first (customers: ask straight out)     |
| **Video, link, follow-ups**  | 6 follow-ups, then a check-in each month                                              | The same                                                                                         | The same, once they've answered (Requests holds only one message)                                                    | The same                                                                                      |
| **Posts**                    | A helpful post in a group, after your OK; who engages is a warm lead                  | A helpful post on your own feed, after your OK                                                   | The AI writes the caption and picks the picture to take; you post. Who engages is a warm lead                        | A post or a forum answer, after your OK                                                       |
| **Its own extras**           | Join groups (3 a day); confirm requests from people who fit                           | Withdraw old invitations                                                                         | Story views and likes (later); answer comments on your own posts                                                     | Recommend (by hand); ask for recommendations; forum answers                                   |
| **Tidying**                  | Cancel old requests, unfriend (you tick who)                                          | Withdraw old invitations                                                                         | Unfollow those who didn't follow back within 3 weeks                                                                 | Withdraw old requests                                                                         |

Every network keeps the same safety rules:

- Each network has its own day, limits, warnings and training wheels.
- A warning stops that network for the day.
- Nothing runs on its own until the person turns it on.
- Messages wait for an OK unless they choose otherwise.
- Don't pitch and Never contact cover a customer on every network.

## How it works today: Facebook and LinkedIn

### Setting up

- **The setup** (`setup.ts`):
  1. Pick playbooks.
  2. Get ready.
  3. The team's rules (owners and admins).
  4. Networks.
  5. Your own settings.
  6. Install the extension.
  7. Save your groups.
- **A playbook** (decision 62) is one niche inside the business's main offer:
  - who it's for, the signs they fit, who to skip, and the area;
  - the problem, the proof, the offer and the booking link;
  - the voice, sample messages and openers;
  - the questions to ask, and the short video's script.
  - One playbook serves every network.
- **Get ready** (decisions 63 and 64) holds everything back until five things are done:
  - the main offer is live;
  - a playbook has its niche;
  - your profile is right;
  - your sample messages are OK'd;
  - you've set a monthly goal.
- **Read my profile:** the extension reads your profile, and the AI checks each part against the offer. It suggests
  three bios (headlines on LinkedIn), a cover line and what to feature. **Put this one in** has the extension write
  the bio or headline. The rest are tips you tick off yourself.

### Finding people

- **Facebook:**
  - your friends, your friend requests both ways, and your chats (from Facebook's download file, or read in
    Messenger);
  - your groups and their members, read slowly, admins first and never approached;
  - new groups, which it asks to join, 3 a day;
  - posts asking for what you sell, looked for every hour or two, with a push to your phone when one is strong;
  - people who react to or comment on your helpful post: warm leads for two weeks.
- **The AI checks the people:** it reads about 40 profiles a day, with each one's business page, and says who fits
  a playbook and why. A friend who fits and hasn't heard from you in a month gets a **Reconnect**.
- **LinkedIn:**
  - your connections and invitations, and LinkedIn's data file;
  - your chats;
  - checks of your connections, 40 a day (LinkedIn shows each look as a profile view);
  - posts found by searching the playbook's words, once a day;
  - people engaging with your own post.

### The day

**Today** is worked out fresh each time, best fits first, in this order:

1. Replies.
2. Messages to send.
3. Likes, friend requests or invitations, and comments.
4. Your helpful post.

What the extension does on its own is your **Sending** choice (decision 26):

- **You do everything:** it only notes your steps. This is where everyone starts.
- **Steps on their own:** likes, requests and comments go on their own; each message waits for one tap.
- **Approve all:** the same, with the day's messages ready each morning.
- **Everything on its own:** messages too, after the training wheels.

On Facebook it works at random times in your working hours. On LinkedIn it works after **Start my day**, with 2 to 6
minutes between steps.

### The conversation

- Once they accept, the **first message** asks straight out whether they'd be open to the offer's outcome, on its
  guarantee.
- The AI reads each answer (decision 66):
  - a yes gets the short video, then the booking link;
  - a question gets a short answer;
  - "not now" gets a check-in in a month;
  - a no ends it.
- Someone who goes quiet gets 6 follow-ups, then a check-in each month (decision 67).
- **Replies** wait for you, or simple ones go on their own (decision 27). Anything touchy always comes to you with a
  push: a refund, a complaint, someone upset.
- A booking through the demo link counts on its own.
- Each person reached has a stage in the **Pipeline**:
  found → warming up → friends → talking → ready to pitch → pitched → booked (or not a fit).
- **Add to Contacts** makes them a customer, with the network as the source.

### Limits and safety

| A day                           | Facebook                 | LinkedIn               |
| ------------------------------- | ------------------------ | ---------------------- |
| Friend requests or invitations  | 20                       | 15, never 80 in 7 days |
| First messages                  | 15                       | 15                     |
| Follow-ups, the video, the link | 20                       | 20                     |
| Comments                        | 15                       | 10                     |
| Likes                           | 40                       | 30                     |
| Helpful posts                   | 1                        | 1                      |
| Profiles checked                | 40                       | 40                     |
| Tidying                         | 30 cancels, 20 unfriends | 20 withdrawals         |

- **The business** can lower any limit, never raise it.
- **Training wheels:** for the first 7 days and the first 25 OK'd messages, every message waits for an OK.
- **A warning** stops that network for the day, halves its limits for 7 days, and stops its requests for 2 days. The
  other networks carry on.

### Three gaps found while writing this

1. **LinkedIn invites only warm leads.** Today's invitations come from two places: people who engaged with your post,
   and members of your groups (`ops/today.ts`). LinkedIn has no saved groups, so someone found by post search gets a
   comment but never an invitation.
2. **LinkedIn's Settings show switches it can't do.**
   - Its page shows every "along the way" switch, Facebook's too: confirm requests, join groups, and the hourly look
     for posts (`settings-view.tsx`).
   - LinkedIn's runner does none of these (`auto/linkedin.ts`: likes, invitations and comments only).
   - With "accept" on, Today would mark LinkedIn's Accept rows as done on their own (`automation.ts`, `autoKinds`),
     though nothing does them. That's from reading the code; nobody has seen it happen yet.
3. **A playbook's steps and networks do nothing.** They're saved, but nothing reads them: every playbook in use runs
   on every network (`playbooks.ts`).

## Instagram

A follow network: there's no friend list to work. People are found through hashtags, places and the accounts like
yours, and likes and comments do the warming up. Instagram blocks fast ("Action blocked"), so its limits start low and
everything goes at a person's pace.

### Your profile

Get ready reads it and the AI checks it against the main offer, as on Facebook:

- **Name:** your name, then what you do and where, like "Dana Reyes | Austin Plumber". Instagram searches the name
  field, and lets you change it only twice in 14 days. A tip: you change it.
- **Bio**, 150 characters at most: who you help, the result, the town, and what to do next. The AI writes three,
  and **Put this one in** writes yours (Check finds its box and Submit).
- **Links:** the main offer's link first. A tip.
- **Picture, highlights and pinned posts:** your face or logo; highlights for services, reviews and questions; up
  to 3 pinned posts that say who you help and show proof. Tips.

### Where the people are, warmest first

1. People engaging with you: new followers, likes and comments on your posts, and replies to your stories (from your
   notifications).
2. Your own followers who fit, checked by the AI as Facebook's friends are.
3. Local hashtags and places from the playbook (#austinplumbing, a neighborhood). The posts and the accounts that
   post them.
4. The followers and commenters of accounts like yours, which the playbook names: the local chamber, a venue, a
   partner.
5. Instagram's search, by the playbook's words. Check already reads it.

### The steps

- **Warm up:** like 1 or 2 of their recent posts. When one is about their work, add a short comment, drafted by the
  AI from the playbook.
- **Follow,** a day after the warm-up, as Facebook's friend request waits after its like.
- **The first message, once they follow back or answer your comment.** It lands in their main inbox, and asks
  straight out as everywhere.
- **No follow-back in 3 days:** one short message. It lands in their Requests, and it has no link and no video, since
  Instagram passes only one text message until they accept. The video and the link come once they answer.
- **Follow-ups:** only in a chat they've answered or accepted. Nothing piles up in Requests.
- **Your posts:** the AI writes the caption and says what picture to take. You post it, from your phone if you like.
  Whoever likes or comments is a warm lead, and the AI drafts your answer to each comment.
- **Unfollow:** people who didn't follow back within 3 weeks, at most 20 a day.

### Starting limits

| A day                   | Instagram                                    |
| ----------------------- | -------------------------------------------- |
| Follows                 | 20                                           |
| Likes                   | 30                                           |
| Comments                | 10                                           |
| First messages          | 10, of which at most 5 to people in Requests |
| Follow-ups, video, link | 15                                           |
| Profiles checked        | 20                                           |
| Unfollows               | 20                                           |
| Posts                   | You post them yourself                       |

A warning stops Instagram for the day, halves its limits for 7 days and stops follows for 2 days.

### The risk, said plainly

Instagram's terms forbid automated access, and it blocks accounts that act too fast. So it gets LinkedIn's rules:

- Your own steps are noted.
- Reading goes at a person's pace, in its own window.
- Doing things on its own is your choice, off to start, at the low limits above.
- Anything public, and every message, waits for an OK to start.

### The inbox

If the business's Instagram professional account is connected in Settings → Facebook & Instagram, its messages
already come into HandsFreeOS's inbox through Meta. When outreach runs from that same account, Social Outreach hears
those messages through core's events, and must not count a reply twice.

## Alignable

Made for local small businesses to refer each other, by town. It works like LinkedIn: connect, then message, then
follow up. What it adds is recommendations and a forum where owners ask "can anyone recommend…".

### Your profile

- **Logo or photo, and the cover:** tips.
- **The description:** who you help, what you do, the town. The AI writes it, and the extension puts it in once
  Check has read the edit form.
- **Services and service area:** right for the playbook. Tips.
- **Recommendations:** at least 5. Get ready shows how many you have, and the AI drafts a note asking your happy
  customers to recommend you, through Alignable's own "ask for recommendations".

### Two kinds of people

- **Customers:** businesses that buy what you sell (marketing, insurance, bookkeeping). The conversation is the usual
  one, asked a little more softly.
- **Referral partners:** businesses whose customers need you. The first message is about them and referring each
  other, and the offer comes when they ask.

Each playbook says which it looks for (question 7).

### Where the people are

1. Your connections who fit, and the requests you've got (the warmest, and quick to accept).
2. Your town's businesses, by the playbook's kinds of business. Alignable groups its members by town.
3. Forum questions asking for what you offer: like LinkedIn's post search, looked at once a day, with a push when
   one is strong.
4. Groups and events that fit: their members, and who's going.
5. Whoever likes, comments on or recommends you: warm leads.

### The steps

- **Warm up:** like or comment on their post, or their forum answer, and view their profile.
- **Connect**, a day after. Check found Connect on a business's page. The next Check reads whether Alignable asks
  for a note.
- **The first message**, once they accept.
- **The video, the link and follow-ups**, as everywhere.
- **Recommend:** only by hand, for a business you know (question 8). Today can suggest it for a customer or partner
  who's worked with you.
- **Forum answers:** the AI drafts a helpful one, and you OK it before it goes (question 9). Whoever asked is a warm
  lead.
- **Withdraw** requests nobody answered, after your wait.

### Starting limits

| A day                   | Alignable    |
| ----------------------- | ------------ |
| Connection requests     | 15           |
| First messages          | 15           |
| Follow-ups, video, link | 20           |
| Comments                | 10           |
| Likes                   | 30           |
| Profiles checked        | 30           |
| Forum answers           | 2            |
| Recommendations         | By hand only |
| Withdrawals             | 20           |

The next Check reads whether Alignable caps requests in a week, as LinkedIn does. A warning works as on the others.

### The risk, said plainly

Alignable is small and publishes little. Its robots.txt keeps every robot out of its signed-in pages, and its terms
are to check. So it gets LinkedIn's rules too, and starts at the limits above.

## What it takes to build

Shared first, then each network as LinkedIn was built (one PR per part, decision 35).

**Shared, in core:**

- **People found by a search** become people to connect with or follow on any network, not only group members. This
  fixes gap 1, and Instagram and Alignable both need it.
- **Steps per network:** each network's runner says which steps it does, and Settings and Today show only those.
  This fixes gap 2.
- **New steps:**
  - Instagram: the follow-back wait before a first message, and the one message to Requests.
  - Alignable: recommend (by hand) and forum answers.
- **A playbook's networks and where to look on each:** hashtags, places and accounts for Instagram; kinds of
  business, town, and customers or partners for Alignable. A playbook's networks start to count (gap 3).
- **Get ready's profile parts** for each, and the AI's words for each: one short message for Instagram's Requests,
  and Alignable's referral tone.

**Each network, in the extension and the apps**, as LinkedIn's six parts were:

1. **Reading:**
   - Instagram: a profile and whether you follow each other, followers, a post with its likes and comments,
     hashtag and place pages, notifications, the inbox and a chat.
   - Alignable: a business's and a member's page, your connections and requests, your town, a forum question,
     groups, events, conversations.
   - Each is tuned from what its Check sends back.
2. **Noting your own steps:**
   - Instagram: Follow, Like, Comment, Send.
   - Alignable: Connect, Accept, Like, Comment, Send, Recommend.
3. **In the app:** the network's day, Today's rows, its limits and choices in Settings, Get ready's profile, Results.
   It leaves the "looking" stage.
4. **Asks:** save my followers or connections, check them for good fits, read my chats, look someone up before
   drafting, read my profile and put the bio or description in.
5. **On its own:**
   - Instagram: like, comment, follow, send what's OK'd, unfollow.
   - Alignable: like, comment, connect, send what's OK'd, withdraw.
   - The once-a-day jobs for both.
6. **Growing:**
   - Instagram: the hashtag and place looks, and your post's warm leads.
   - Alignable: the forum's questions and the town's businesses.

**What the code says about it** (read for this plan, 17 Oct 2026):

- **Today's steps aren't kept per network.** Every network gets the same kinds (`today.ts`). What differs is where
  its people come from, and what its runner does: each network has a runner of its own (`auto/linkedin.ts` is LinkedIn's).
- **New people come only from groups.** For a friend request or invitation, Today reads group members
  (`group_people`) besides warm leads. Hashtags, places, towns and search results need a source of their own, and a
  playbook needs fields to say where to look on each network; today it has signs and group words only.
- **A follow isn't a request.** Following a public account is at once, and private accounts are the only ones with
  requests. So Instagram needs follow states, a follow-back that counts as accepting, and a cap on whom you follow
  (7,500), not on your followers.
- **Instagram's Requests have no reader yet** (`/direct/requests/`), and a message waiting there can't take a
  follow-up.
- **Recommend and forum answers are new everywhere:** a kind on Today, a daily limit, a kind of touch, the words and
  a migration widening the database's checks.
- **Several database checks are still Facebook's:**
  - the kinds of touch (`touches.kind`), friendship states (`profiles.friendship`, `friends.state`), and what waits
    for the person (`needs.step`);
  - what a computer is doing (`computers.doing`), and the kinds of ask (`asks.kind`);
  - a group's id, digits only (`groups.platform_id`): Alignable's communities have names in their addresses.
  - Each new kind widens these in a migration, on the hosted database before `main`.
- **Get ready's profile check knows only Facebook and LinkedIn** (`profileCheckSystem`, and the worker's schema, which
  wants an About). Each network needs its own parts, lengths and words.
- **The helpful post's prompt** gives every network but Facebook LinkedIn's. Instagram's needs a picture to take, and
  Alignable's a forum or feed of its own.
- **Turning a network to `working` comes last.** That alone lets its day start, and puts it on Today's strip, the
  filters, the setup and the playbook's networks.
- **A small slip to fix on the way:** "a Alignable group" in Today's words (`withArticle` is the fix).

## Build order

1. **Chris answers the questions above.**
2. **Shared work in core:** people found by a search, steps per network, a playbook's networks. This closes
   LinkedIn's gaps first: invitations for people found by post search, and only its own switches in Settings.
3. **The next Checks** read what's left: Alignable's profile form, its Connect box (is there a note?), a conversation,
   a forum question, a town page. Instagram's followers list, a hashtag page, a place page, its notifications, a chat.
4. **The first network:** Alignable (recommended), parts 1 to 6.
5. **The second:** Instagram, parts 1 to 6.
6. **Chris tries each** on his own account, as he did LinkedIn, and the readers are tuned from what its Check sends
   back.

Each step's migration goes on the hosted database before `main` (CLAUDE.md, "Database migrations").
