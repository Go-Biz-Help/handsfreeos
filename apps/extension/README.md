# HandsFreeOS Social: the browser extension

The extension that works beside a person on Facebook, and later LinkedIn and Instagram, for the Social Outreach
add-on (docs/outreach.md). It connects to HandsFreeOS only for businesses that have that add-on on.

**This is a test build (0.25.0), and a bare one** (decision 43 in docs/outreach.md). Everything is set and started
in HandsFreeOS; the extension does the work on Facebook. Its side panel keeps only signing in, what it's doing right
now with **Start my day** and **Stop for today**, **Waiting for you**, and a link to HandsFreeOS.

Signed in, it notes the friend requests, likes, comments and messages you send yourself, with the group you found
each person in, and your answers to friend requests. In the Facebook tab in front of you it reads Facebook's
warnings, and, as your settings say, the chats you open and the posts in a group as you scroll. It works your list
for today on its own, as far as you let it. And it does what you ask of it from Social Outreach's Friends, Groups,
Chats and Today tabs (and the phone's Groups and Chats screens): getting your Facebook file and bringing it in, saving your friend requests, friends list,
groups and their members, finding groups and posts, reading your chats for the AI, checking your friends for good
fits, cancelling old friend requests and unfriending the people you tick, and looking someone up before the AI drafts
to them. It stops for the day on any
Facebook warning, and tells HandsFreeOS what it's doing, so the app shows it live. Its icon shows how many things
wait for you, and Chrome's pop-ups tell you of new ones, as your phone does. It never sends a message you haven't
OK'd, and never clicks, scrolls or changes a page but for what you asked or let it do.

## What it reads

| Page                                        | What it shows                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A profile                                   | Name, bio and details, whether you're friends, mutual friends, recent posts                          |
| Friends, followers, following, friends list | Each person, with the line under their name                                                          |
| Your friend requests                        | Each request in the list beside the page, how long ago and their mutual friends; answered ones too   |
| A group's People tab                        | The group, and each member with the list they're in; admins and moderators are marked to leave alone |
| A group                                     | The group (public or private, members, joined or not) and its posts                                  |
| Your groups                                 | Each group, with the line under its name                                                             |
| Search results                              | People, groups and posts                                                                             |
| Chats, and an open chat                     | Each chat with its last message; an open chat's messages, who sent each, when                        |
| Notifications                               | Who accepted your request, reacted, commented or mentioned you                                       |
| Any page                                    | Facebook's warnings: a temporary block, a limit, a security check                                    |

Facebook loads lists as you scroll, so a reader only sees what's on the page; the jobs scroll for more. A group's
People tab shows only a few of each list, admins and moderators too: its **See all** pages are read the same way.

Facebook draws some pages two ways, and both are read. Since 2026 a profile can have its name, bio and details at the
top instead of an Intro card, a group's People tab has a row of faces above its tabs (left out: the lists below say
who each person is), an open chat repeats each message at the end of it for screen readers, saying who sent it
(read once, and used to tell whose it is), and posts in the News Feed aren't articles while their comments are
(comments are never read as posts). A friend request shows the faces of mutual friends, which link to them: each
request is about the one person it names in words, and the faces aren't requests. Facebook keeps a hidden copy of
each request's Confirm and Delete beside the ones shown (left out), and a request you've just answered says so in
place of them ("Request accepted") until the page loads again. **View sent requests** opens the ones you've sent
in a box over the page, and Facebook hides the page behind it: while the box is open, it's the list that's read.
Picking someone in the list opens their profile beside it, with **Confirm request** and **Delete request** under its
intro and the same two in its **Respond** menu; its address has their number and its tabs their username, and the
answer is noted with both. A chat open in a small window over another page is known by its messages, labelled as the
conversation, and is with whoever its header links to.

## The panel

Press the extension's button on any page and Chrome's side panel opens beside it (`src/panel/`, `public/panel.html`).
It shows what's going on and leaves the rest to HandsFreeOS:

- **Signing in** (`src/panel/account.ts`), the way the phone app does: an emailed 6-digit code, or a password, for an
  account that already exists (new accounts start on the web). It then works for one business, picked at the top
  when there are several. Only businesses where Social Outreach is on and you have **Use Social Outreach** are listed;
  with none it says there's nowhere to work, and if Social Outreach is turned off it says so and the business leaves
  the list.
- **Right now** (`src/panel/status.ts`): what it's doing (working, waiting for the next step, stopped, standing by)
  with its line and when; the next step; why it isn't working when it isn't (another computer works for you, noting is
  off, you do everything yourself); Facebook's warning that day; a warning when your own steps today go past a daily
  limit (`pastLimitWords`, from `outreach.activity`: the limits count, they don't stop); your settings in one line, the
  hours and training wheels in it, with **Change in HandsFreeOS**; **Start my day** and **Stop for today**, with HandsFreeOS's words when it refuses one; and anything
  you asked of it from HandsFreeOS while it goes, with **Carry on**, **Skip** and **Stop**.
- **Waiting for you** (`src/panel/waiting.ts`), below.
- **Open HandsFreeOS**, at the foot, opens Social Outreach's Live tab for the business, and **Page read wrong?**,
  folded away, holds **Copy page outline** and **Save page outline** (below, "When it reads a page wrong").

**The first time** (decision 45 in docs/outreach.md): setting up Social Outreach happens in HandsFreeOS, not here.
Whenever someone is signed in, it tells HandsFreeOS so (`outreach.setup.save` with `extension`): at each sign-in or
business picked, and otherwise at most every 6 hours (`hfos.setupReported`; a refusal waits the same, and only a lost
connection is tried again sooner), so the setup's install step ticks by itself, also for a build updated over an old
sign-in. Signing in, or picking another business, opens HandsFreeOS's setup in a new tab when HandsFreeOS's answer to
that report says the person is a first-timer there (never saved their own settings and never started the setup), once
per person and business on this computer (`hfos.setupOpened`), and never two tabs for two sign-ins at once
(`src/hfos/setup.ts`). **Save my groups**, asked from the Groups tab or the setup's groups step, saves each group on
Facebook's page of your own groups (facebook.com/groups/joins/) as one you're in (`src/jobs/groups.ts`), which is
what the setup's groups step lists.

Opening the panel, or coming back to it, makes this the computer that works for you (below, "What it tells
HandsFreeOS"). Nothing is saved from it: the people you reach are kept by noting, and Add to Contacts, Demo booked,
Keep and Don't pitch are on the web.

## What it notes

Signed in, the extension notes four steps as you take them on Facebook yourself, in any Facebook tab, with the panel
open or not (decision 8 in docs/outreach.md), and your answers to the friend requests you get. It notes who each step
was to, never what you wrote.

| Step           | Noted when you…                                                                   | To                                                                  |
| -------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Friend request | press **Add friend**                                                              | the profile it's at the top of, or the one person its card links to |
| Like           | press **Like** on a post or a comment (not when you take a like back)             | whoever wrote the post or the comment                               |
| Comment        | press Enter or the send button in a comment box with something in it              | whoever wrote the post, or the comment you're replying to           |
| Message        | press Enter or the send button in a chat, or in a small chat window over a page   | who the chat is with                                                |
| Confirm        | press **Confirm** on a friend request you got, or in a profile's **Respond** menu | who asked: they're your friend in HandsFreeOS too                   |
| Delete         | press **Delete** on a friend request you got, or in the same menu                 | who asked: their request is kept as deleted                         |

Each step is kept with the group you found the person in: the group whose page or post it was on, or the group you
opened their profile from earlier (remembered until Chrome closes). HandsFreeOS works out whether a message started a
chat, followed one up on a later day, or answered them. Noting adds nobody to Contacts: a person reached is kept with
their profile until you save them.

Left out: other reactions than Like, steps to yourself, and a step it can't tie to one person, such as a button on a
card with several people. Popups and Facebook's other layouts may slip past; tell us what it missed, with an outline.
Answers to requests aren't outreach, so they don't count toward the daily limits.

Social Outreach's Live and Activity tabs show today's steps against the daily limits and who wrote back. **Note my
steps on Facebook**, in your settings in HandsFreeOS, turns noting off and on; it starts on. When HandsFreeOS can't
be reached, steps wait in the extension, up to 200, and go in order when it's back. Steps in the extension's own
windows and tabs are its own, never noted as yours.

**Who wrote back** (decision 22): while noting is on, each Facebook tab looks at the chats on the page as it changes,
at most every 10 seconds and not in the 20 seconds after you send one: Messenger's list (a line that doesn't start
"You"), the chat open on its page, and small chat windows over any page, where the last message is theirs
(`src/facebook/replies.ts`). The background sends who (the chat's number or their profile, never what they wrote),
only chats from the last two days and each at most every 3 minutes (`src/hfos/replies.ts`). HandsFreeOS counts one
only when it answers a message of yours it noted, and tells your phone unless you had that tab in front of you.

## What you can ask it from HandsFreeOS

The buttons on Social Outreach's Friends, Groups, Chats and Today tabs ask your computer to do something on Facebook
(an ask, `outreach.ask.make`; decision 43 in docs/outreach.md). The computer that works for you hears of it within
seconds on the live channel (`src/hfos/follow.ts`), or with its next beat's answer, takes it (`outreach.ask.take`,
the oldest first), does it with the jobs in `src/jobs/`, and says how it's going and how it ended, which the web
shows under the button and on the Live tab, and the panel under **Right now** (`src/asks/run.ts`,
`src/hfos/asks.ts`). A kind of ask newer than the build on the computer (`ASK_KIND_SINCE`: checking friends 0.21.0,
checking and joining groups 0.22.0, putting a helpful post up 0.24.0) isn't asked of it: the button says to update
the build, and how. A build that's handed a kind it doesn't know ends it saying so, and goes on to the next ask.

| Button, and where                                                                          | What it does                                                                                                                                                                                                                                                                                            | Where it works, and its pace                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Ask Facebook** (Friends, Let the extension get your file)                                | In Accounts Center's Export your information: keeps only Messages, Friends and Followers, sets All time, JSON and Lower quality, and starts the export; stops if Facebook is making one already                                                                                                         | A tab you can see; you type your password there                                    |
| **Download my file** (the same)                                                            | Once Facebook has emailed you, presses Download beside the file                                                                                                                                                                                                                                         | The same                                                                           |
| **Get my chat backup** (the same)                                                          | From ⋯ beside Chats, Privacy & safety, End-to-end encrypted chats, Message storage: downloads the backup from all time without media, for chats newer than the file has                                                                                                                                 | The same; you type your PIN there                                                  |
| **Bring them in** (the same)                                                               | Finds Facebook's zips in Chrome's downloads, however they were downloaded, reads them and sends names, dates and each one-to-one chat's latest 20 messages, as the Friends tab's card does (`src/jobs/file-in.ts`)                                                                                      | The offscreen page (`src/offscreen.ts`); needs **Allow access to file URLs**       |
| **Check my friend requests** (Friends)                                                     | Saves the friend requests you've got, a few screens of them (`src/jobs/people.ts`)                                                                                                                                                                                                                      | A window of its own, 4 to 9 seconds a screen                                       |
| **Save my friends list** (Friends)                                                         | Scrolls your friends list to the end and saves it, 500 at a time                                                                                                                                                                                                                                        | The same, up to 150 screens                                                        |
| **Check my friends** (Friends)                                                             | Asks HandsFreeOS who's next (friends you've chatted with first), opens each profile, checks it's them, reads their intro, latest posts and the business page it links to, and sends those lines for the AI (`src/jobs/checks.ts`, decision 46)                                                          | A window of its own, one person every 15 to 30 seconds, up to 40 a day             |
| **Check my groups** (Groups)                                                               | Asks HandsFreeOS which groups are next (yours first, then ones that fit by name), opens each, reads its latest posts, then its About tab (what it's for and its rules), and sends them for the AI (`src/jobs/groups-check.ts`, decision 48)                                                             | A window of its own, one group every 8 to 16 seconds, up to 8 (4 a day on its own) |
| **Find and join more groups**, **Ask to join** (Groups)                                    | Asks HandsFreeOS which groups to join (with none, searches with your playbook's words and checks the best 3 first), presses **Join group**, writes in the AI's answers to its questions, ticks that you agree to the rules, submits, and notes how it went (`src/jobs/join.ts`, `src/facebook/join.ts`) | A window of its own, one group every 20 to 40 seconds, up to 3 a day               |
| **OK, post it** (Today, a helpful post)                                                    | Opens the group, presses **Write something…**, types the post you OK'd into the box Facebook opens, presses **Post**, finds it at the top of the newest posts for its link, and notes it (`src/jobs/helpful.ts`, `src/facebook/compose.ts`, decision 50)                                                | A window of its own, one post                                                      |
| **Cancel the ticked requests**, **Unfriend the ticked** (Friends)                          | Opens each profile you ticked that's still on the lists, checks it's them and where you stand, presses **Cancel request** (or **Friends**, **Unfriend** and **Confirm**), checks it says **Add friend** after, and notes it (`src/jobs/tidy.ts`)                                                        | A tab you can see, one person every 20 to 40 seconds, up to 30 and 20 a day        |
| **Save my groups**, **Find groups** (Groups)                                               | Your groups, or a search for groups with the words you gave, scrolled and saved with how each fits your playbooks (`src/jobs/groups.ts`)                                                                                                                                                                | A window of its own, 4 to 9 seconds a screen, 8 screens                            |
| **Save a group**, **Save its members**, **Save members of my best groups** (Groups, Today) | A group's admins and moderators read to the end first, then a few screens of its members; the best groups are up to 3 of your Work these, those with fewest saved first                                                                                                                                 | A window of its own                                                                |
| **Find posts** (Groups)                                                                    | Your Work these groups (or Maybe, with none), up to 5, each feed scrolled a screen at a time; the posts worth a look go to the AI, and the good ones on Today (`src/jobs/posts.ts`)                                                                                                                     | The same, 6 to 12 seconds a screen, 8 screens a group                              |
| **Read my chats** (Chats)                                                                  | Opens your chats in Messenger one at a time from the list and scrolls it for more, skipping any read in the last day that hasn't changed; group chats are left out (`src/jobs/chats.ts`)                                                                                                                | The same, 7 to 14 seconds a chat, up to 150                                        |
| **Draft a message**, **Draft a comment** (Today, while it's online)                        | Opens their profile, reads their intro and latest posts and the business page their intro links to, then has the AI draft with those lines; the drafts come back on the ask (`src/jobs/lookup.ts`)                                                                                                      | A window of its own, closed after                                                  |

- **One at a time, never beside the runner.** Asks take turns with the runner on Facebook (`src/auto/turns.ts`): the
  runner waits ("Doing what you asked from HandsFreeOS first") and carries on after. Asks go outside your working
  hours and after Stop for today too, since you're asking now.
- **How it's going:** a new state goes to HandsFreeOS at once, and a new line alone at most every 20 seconds
  (`lineDue`), with no receipt kept. How it ended goes with its own id and moment; with no connection it waits
  (`hfos.ask.ends`, at most 20) and goes with the next beat. The ask under way is kept in `hfos.ask` for the panel;
  one left there when the extension starts again (Chrome closed mid-way) is ended as lost.
- **Steps it hands to you:** a step it can't find on Facebook's download pages or a profile it hands to you: the tab
  comes to the front, Chrome pops up, your phone hears "Your computer needs you", and it waits for **Carry on** (or
  **Skip**, for someone ticked) from the panel, Waiting for you, or the web, asking HandsFreeOS for your answer every
  20 seconds. Half an hour with no answer stops it. While Facebook asks for your password or PIN, it waits for you to
  type it there; it never types one.
- **Stops:** **Stop**, in the panel or the app; Stop for today, pressed in the panel, the app or the phone; another of
  your computers working now; or Facebook's warning that day, seen here in any tab or on another of your computers,
  which ends any ask on Facebook before it starts, or at its next page while it goes (all but **Bring them in**,
  which doesn't open Facebook); or signing in, signing out or picking another business here (`signInChanged`), and it
  checks before each call to HandsFreeOS that you're still the one signed in, to the same business, so nothing of
  yours goes as anyone else's: its end waits until you're back. A stopped ask ends with why and how far it got
  ("Stopped: you pressed Stop for today. Requests cancelled: 2 people.").
- **Only Facebook's pages:** the extension's own tab opens only https addresses on www.facebook.com,
  web.facebook.com and accountscenter.facebook.com (`workUrl` in `src/facebook/urls.ts`, checked in `src/tab.ts`), so
  a bad link kept in HandsFreeOS or read off a page is refused with plain words and never opened.
- **Done or not:** an ask is **Done** only when its job did what was asked. Stopped, warned, or unable to (nothing to
  save, HandsFreeOS refusing a save, a page that didn't load) it ends as failed, with the job's words.
- **What it keeps:** `hfos.ask` and `hfos.ask.ends` above, and `hfos.facebookFile`: when you asked Facebook for your
  file, and which zips were brought in. The offscreen page (the `offscreen` permission) is opened only to read the
  zips and closed once they're in.

## Reading as you go

In the Facebook tab in front of you, panel open or not, the content script looks at the page as it settles, every
10 seconds at most (`src/facebook/looking.ts`), and the background notes what it found (`src/hfos/looked.ts`):

- **Facebook's warnings**, always (below).
- **A chat you open**, while noting and **Read chats as I open them** are on (both start on): its latest messages go
  for the AI to read when there's something new, one chat per person, joining what the file brought in.
- **A group's posts as you scroll**, while noting and **Look for posts as I scroll a group** are on: the posts that
  say your playbooks' signs or ask for help go for the AI to check, each at most every half hour, and the good ones go
  on your list for today. Groups whose people wrote back or booked a demo take 3 of the 5 places Find posts works
  (decision 34, `@hfos/core/addons/outreach/results`).

The extension's own windows and tabs are never read this way: they're its work, not yours.

## Your settings

Everything the extension does is set in HandsFreeOS, on Social Outreach's **Settings** tab, on the web or in the
phone app (decision 37 in docs/outreach.md); it keeps nothing of its own. Signing in loads them, and a change made there reaches it within a
few seconds while Chrome is open: the background listens on the same live channel the web app does and asks
HandsFreeOS again when anyone's choices or the business's change (`src/hfos/follow.ts`). It writes what the Facebook
tabs read (noting, reading chats as you open them, looking for posts as you scroll) into its storage from them. When it can't listen, each step the runner takes loads them again. Owners and admins can change yours;
your settings then say who did.

## On its own

**On its own** lets the extension do some of your list for today by itself (decisions 26
to 33 in docs/outreach.md). Your choices are your own, set on Social Outreach's **Settings** tab in HandsFreeOS
(decision 37, `outreach.automation`); the panel shows them in a line with **Change in HandsFreeOS**:

- **What it does on its own:** nothing (**You do everything**, to start), friend requests, likes and comments on
  their own with each message waiting for one tap, the same with the day's messages ready to **Approve all**, or
  everything on its own; and **Replies**. Your business may allow only some of them.
- **Like one of their posts a day before each friend request** (on to start): the list then has **Like a post first**
  for people you'll ask tomorrow, and their request comes a day after the like. A profile with no post of theirs to
  like gets its request without one.
- **Confirm friend requests from people who fit a playbook** (on to start): **Confirm their request** on your list.
- **Join good groups when my groups run low** (on to start): with less than a week of people left to reach in your
  groups, it finds groups with your playbook's words and asks to join up to 3 good ones a day, the AI answering their
  questions from your playbook (decision 48).
- **Helpful posts** (after your OK, to start): once a day the AI writes a post that helps the people in one of your
  groups. You copy it and post it yourself, the extension posts it after your OK on Today, or on its own in your
  hours (decision 50); your business may allow only some of these.
- **Look for new posts asking for what I offer, every hour or two** (on to start): in your hours, it looks at the
  newest posts in your best groups; one asking for what you offer pushes to your phone and tops your list (decision
  49).
- **Once a day, first** (on to start): checking your friend requests, saving your groups' members, Find posts, Read
  my chats and checking your friends for good fits, which fill your list, and checking your groups and joining good ones
  when they run low (decisions 32, 46 and 48).
- **When:** your working hours and days, on your business's clock (9 AM to 5 PM, Monday to Friday, to start).

With **Once a day** ticked, the first thing it does each working day, or after **Start my day**, is fill your list, a
job at a time, a minute or few apart, in its window (`src/auto/daily.ts`, `src/jobs/`): it saves the friend requests
you've got (Friend requests, loading a few screens of them); checks up to 4 of your groups for your people (Check my
groups); while **Join good groups when my groups run low** is on and your groups have less than a week of people left
to reach, asks to join up to 3 good groups (the only thing it presses here); the admins and moderators of up to 3 of your Work these
groups (the ones with fewest saved first), read to the end, then a few screens of their members (a group whose admins
don't load to the end waits for another day, so nobody who runs it is suggested); Find posts in those groups; Read
my chats, up to 60 a day; Check my friends, the day's 40; and, last, it asks for today's helpful post and reads who
commented on and reacted to yours up in the last fortnight (`helpfulDaily` in `src/jobs/helpful.ts`): each a warm
lead on your list. Its line says what each found. They only read and save, as the same asks from HandsFreeOS
do, but for asking to join.

Then, in your hours, every hour or two at random, it opens up to 5 of your best groups sorted by new posts, reads two
screens of each and sends them for the AI (`watchPosts` in `src/jobs/posts.ts`), between the day's steps. One the AI
calls strong, someone asking now for what you offer, pushes to your phone and goes first on your list, and it
comments on it first. When you let it post on its own, it puts up today's helpful post once the AI has written it.

In your hours it goes down the list at random times spread over the day, in this order: requests to confirm, posts to
like, friend requests, then comments. **Start my day** starts it now and goes a minute or few apart, hours or not;
**Stop for today** stops it until your next hours. It works in a window of its own beside yours, which it opens
without taking you away from what you're doing, and closes when there's a long wait. For each one it opens their
profile or the post, checks it's them and where you stand, presses **Confirm**, **Like** or **Add friend**, or types
the AI's first comment draft into the post's own box and sends it, then checks it worked and notes it as the
extension's own. Anything not as expected is passed over for the day, with why in the panel's line. It keeps your
daily limits (the list never holds more than they have room for), stops for the day on any Facebook warning, and works
only while Chrome is open, you're signed in and noting is on (`src/auto/run.ts`, `src/auto/plan.ts`,
`src/facebook/auto.ts`, `src/panel/status.ts`). On Today in HandsFreeOS what it does says **Done on its own**, and
your phone's morning push leaves those out. What you ask of it from HandsFreeOS goes first: the runner waits for it
and carries on after.

## What it tells HandsFreeOS

Signed in, the extension tells HandsFreeOS how things stand on your computer, so Social Outreach's **Live** tab on the
web and the phone shows it as it happens (decision 41 in docs/outreach.md, `src/hfos/live.ts`):

- **This computer.** Each install makes an id once and keeps it in its storage (`hfos.computer`), with a plain name,
  "Chrome on Windows" or "Chrome on Mac", that you can rename on the Live tab. Only the computer you used last works:
  opening or coming back to the panel, a step of your own on Facebook, signing in, or Start my day or Stop for today
  pressed there makes it the one. On the others the runner stands by, and the panel says which computer works and
  how to work from this one instead. Nothing hands over by itself.
- **The beat** (`outreach.live.beat`): every minute while Chrome is open and you're signed in (the `hfos-beat` alarm),
  and a couple of seconds after the runner's state changes, a step is taken or you use the computer. It sends what the
  runner is doing (working, waiting for the next step, stopped, paused, standing by), its line and when the next step
  is, and the steps it took since (`hfos.live.steps`, each with its own id, kept until HandsFreeOS has it). A line alone
  goes at most every 20 seconds, and a line longer than 300 characters is cut short, so a beat is never refused for its
  wording. A beat that changes nothing keeps no record and tells nobody. With no beat for 3
  minutes the Live tab says your computer is offline and when it was last seen. Signing out sends a last beat that says
  so.
- **Your day:** **Start my day** and **Stop for today** in the panel are kept in HandsFreeOS (`outreach.day.start`,
  `outreach.day.stop`), and pressed in the app they reach this computer within seconds over the live channel; the
  answer to each beat says where the day stands (`hfos.live`). Offline, a press here waits (`hfos.live.press`), keeps
  its moment and goes with the next beat; a newer press wins. HandsFreeOS refuses Start my day after a Facebook warning
  that day, or while you do everything yourself, and the panel says why; Stop for today always stops here. A warning
  seen here is never undone here. A press here updates the answer kept at once. When a beat's answer says the day
  stopped or another computer works now, a once-a-day job under way ends at its next page, and the runner looks again
  as soon as the step under way is done.
- **Whose:** every line, waiting press and answer kept says whose it is (you and the business), so none goes as
  someone else's or to another business after signing in as someone else.

## Waiting for you: the number and the pop-ups

**Waiting for you**, in the panel, is the same list as the Waiting for you tab in HandsFreeOS (decisions 40 and
42 in docs/outreach.md, `outreach.waiting`): something you asked of your computer that needs you (**Carry on**,
**Skip**, **Stop**), replies handed over to you, messages waiting for your OK, each under the chat so far (with **Approve
all**, which leaves a reply handed over or one to someone who needs you, each to OK on its own), steps the extension
couldn't do and hands to you (**I did it** or **Let it go**), and friend requests to decide (**Leave it**). The
background keeps it (`src/hfos/waiting.ts`), and the panel draws it (`src/panel/waiting.ts`):

- **The number on its icon** is everything waiting (`chrome.action.setBadgeText`, "99+" past 99). It's asked again a
  moment after a change of yours heard on the live channel (a message drafted, OK'd or sent, a step noted or handed
  over, a request answered), one HandsFreeOS made itself (a download brought in), or a change to your pushes, hours
  or training wheels by anyone (an owner may change yours); after you act on one in the panel, after signing in, and
  every 10 minutes with nothing heard (the `hfos-beat` alarm). Signed out, or with Social Outreach turned off or out
  of your reach, there's none; with no connection, the last number stays.
- **Chrome's pop-ups** (the `notifications` permission) follow your **pushes** setting, as your phone does: one for
  what's new at most every 2 hours in your working hours (to start), or one for each, with more than 3 at once going as
  one. A reply handed over pops up at once either way, and isn't told again in the bundled one; friend requests never
  pop up. Only the computer that works shows them (src/hfos/live.ts); the first look after signing in tells of what's
  there, replies too, in one pop-up at most. A click opens the side panel in the window you last used (kept in the
  session's storage, so a click that wakes the background still knows it); **Open in HandsFreeOS**, or a click Chrome
  won't open the panel for, opens Waiting for you on the web.
- **The panel's list** shows only while it's for who's signed in and the business they save to, so picking another
  business never shows, or acts on, the last one's. **Approve all** names the same number as the web's. **I did it**
  on a step the extension couldn't do again since says so, and the step stays.
- **Steps it hands to you:** when the runner can't find a button or the box, Facebook shows a different page, or
  Facebook doesn't take a step, it hands the step to you (`outreach.need.note`, from the same waiting list as the
  steps it notes, so it keeps its moment offline), and still tries again another day. A message that didn't go is
  handed over by HandsFreeOS itself. The step noted later, however it was done, takes it off.
- **What it keeps:** the last list (`hfos.waitingFor`) and what a pop-up told of (`hfos.waitingFor.told`), each saying
  whose it is (you and the business). `hfos.waiting` is the steps waiting to be sent (src/hfos/noting.ts), not this;
  Today's count of them leaves out the steps handed to you.

## Facebook's warnings

Any warning it sees ("You’re temporarily blocked", "going too fast", a security check), in the tab in front of you or
one it works in, is noted in HandsFreeOS once a day for the same words (`src/hfos/looked.ts`, `outreach.warning.note`,
decision 25). The extension then stops for the day: nothing done on its own, and no ask on Facebook (bringing in
your file still works). It keeps the day's warnings itself (`hfos.warned`, `src/hfos/warned.ts`), so it stops even
when HandsFreeOS can't be reached, and a warning seen on another of your computers stops it too. For 7 days your
daily limits are halved, and for 2 friend requests are off your list. A red note says so under **Right now**, and on
the web.

## Load it in Chrome

People on a business's team follow the setup in HandsFreeOS (Social Outreach sends a first-timer there; Settings →
Set up again, or the Carry on line on any tab, opens it), which has the download link and these steps in plain
words. To hand out a build, zip the **contents** of `dist/chrome` so `manifest.json` is at the zip's top (into `dist/`, which git ignores, never into the repo), put the zip wherever the team downloads files
(a shared drive, a release page), and paste its https link under Social Outreach → Settings → Business settings →
**Where your team gets the extension** (on the web or the phone). A newer build goes the same way: people unzip it
over the same folder and press the reload arrow. When a business starts Social Outreach fresh, the extension
forgets what it kept on the computer for it (chats read, steps not yet sent, the setup opened) the next time it loads
its settings (`forgetOnFreshStart`). Once everyone has the bare-bones build (0.19.0, settings part 4, or
newer), set the API's `MIN_EXTENSION_VERSION` to it, so an older build that still saves from its panel is refused
with an ask to update; `outreach.profile.save` and `outreach.chat.save` can then be retired (docs/outreach.md, "Not
yet").

To load your own build:

1. Build it: `pnpm --filter @hfos/extension build`. It lands in `apps/extension/dist/chrome`. To sign in, the build
   needs HandsFreeOS's publishable Supabase key in `HFOS_SUPABASE_PUBLISHABLE_KEY` (see "Where it signs in" below);
   without it the extension can't sign in.
2. Open `chrome://extensions`, turn on **Developer mode**, press **Load unpacked** and pick that folder.
3. Pin it from the puzzle-piece menu, open facebook.com, and press its button: the side panel opens beside the page.
4. To bring in your Facebook file from your downloads, press **Details** on its card and turn on **Allow access to
   file URLs**.

After a rebuild, press the reload arrow on the extension's card. A Facebook tab that was open before the extension was
loaded gets the reader when it's next reloaded, or the first time the extension asks it to read.

`node scripts/build.mjs --watch` rebuilds on every change.

## Where it signs in

The build writes where it signs in and saves into the bundle, from these settings in the environment, or in `.env.local`
or `.env` beside `package.json` (both gitignored; `.env.example` lists them):

| Setting                         | Left out                                      |
| ------------------------------- | --------------------------------------------- |
| `HFOS_API_URL`                  | `https://api.handsfreeos.com`                 |
| `HFOS_WORKER_URL`               | `https://hooks.handsfreeos.com`, for drafts   |
| `HFOS_WEB_URL`                  | `https://app.handsfreeos.com`                 |
| `HFOS_SUPABASE_URL`             | `https://ybupfghakoszfcxhyrby.supabase.co`    |
| `HFOS_SUPABASE_PUBLISHABLE_KEY` | none: the build reads pages and can't sign in |

The publishable key is public, like the web app's `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and still stays out of the
repo. **Point it at your own computer:** `pnpm env:local` writes `.env.local` with your local stack's values, so a
build after it signs in to the API on port 4000.

## When it reads a page wrong

**Copy page outline** and **Save page outline**, under **Page read wrong?** at the foot of the panel, give the
page's structure as plain text: tags, roles, Facebook's own words and labels, and the shape of every link.
Everything a person wrote becomes `[2 words]`, and the people, groups and chats that links lead to become `{1}`, `{2}`…, the same number each time the
same one comes up. With the reader's counts at the top, that's enough to see what Facebook changed and fix the reader.

## Rules worth knowing before changing anything

- **Addresses first.** `src/facebook/urls.ts` decides what kind of page it is and what each link points to. Facebook
  changes its page code every week and its addresses hardly ever, so anything a link can tell, a link tells.
- **Never a class name.** Facebook's are scrambled and change constantly. The readers use links, roles, ARIA labels,
  headings and Facebook's own words (`src/facebook/vocabulary.ts`), in English for now.
- **Found by its link.** A person, group or chat is found by the link to it, and read from the largest box around that
  link that holds no link to anything else of the same sort (`collectLinked` in `src/facebook/dom.ts`).
- **Page order, not the boxes around things.** An outline leaves out the bare boxes Facebook wraps around everything,
  so a reader never counts on what sits directly inside or beside an element: it goes by what comes before or after
  it on the page (`isBefore`, `elementsAfter`). `test/boxes.test.ts` reads every test page again with a bare box around
  each element and expects the same.
- **Reading only when asked, and noticing only the person.** The content script reads when the background asks (a
  job, the runner), and in the tab in front of the person it looks at the page as it settles for Facebook's warnings
  and, as the switches say, the chat open and a group's posts (`lookFor`); never in the extension's own work tabs.
  Besides that it only listens for the person's own clicks and Enter presses (`isTrusted`, never the page's), works out from the page
  around them whether one was a step and who to (`src/facebook/actions.ts`), and tells the background. It never reads
  what was written, writes to the page, clicks, scrolls or sends anything, but for the next rules. What it does on its
  own keeps the owner's decisions: off by default, the daily limits, and a stop for the day on any Facebook warning.
- **Scrolling groups only when asked, slowly.** **Find posts** (`src/jobs/posts.ts`) only scrolls a group's own
  feed (`scrollFeed`, `groupFeedPage`), a screen at a time, 6 to 12 seconds apart: it opens nothing and presses
  nothing. Once a day, on its own, it also scrolls your friend requests and a group's members the same way
  (`scrollList`, `peopleListPage`, `src/jobs/people.ts`), 4 to 9 seconds apart, and your friends list and groups
  when asked (`scrollPage`, only on those pages). The look-up before drafting (`src/jobs/lookup.ts`) only opens and
  reads two pages in a window of its own, then closes it; none of these go on a day Facebook warned you.
- **Opening chats only when asked, slowly.** **Read my chats** (`src/jobs/chats.ts`) clicks the chat links in
  Messenger's own list and scrolls that list (`src/facebook/browse.ts`), nothing else: never a button, never a box to
  type in. One chat every 7 to 14 seconds, at most 150 a run (60 once a day on its own), and it stops at once on a
  Facebook warning.
- **Pressing only on the download pages, only when asked.** `src/facebook/fetch.ts` presses Facebook's buttons only
  on Accounts Center's download pages and the chats (`fetchPage`), only for an ask the person made in HandsFreeOS,
  and only what's in the box on top, never behind it. It never types: a password or PIN box on the page makes it
  wait for the person. Each step lists the words it may go by, the likeliest first, and one it can't find is handed
  to the person rather than guessed. `test/fetch.test.ts` walks a made-up Accounts Center, and again with bare boxes.
- **Pressing on profiles only for the people ticked.** Cancelling and unfriending (`src/facebook/tidy.ts`) press only
  on a profile (`tidyPage`) the person ticked on the Friends tab, and only those still on its lists, after checking
  it's them (`sameProfile`) and where things
  stand. The first press is a button under their name, never a link or the Friends tab (`buttonsOnly`); Unfriend and
  Confirm are pressed only in Facebook's box on top (`inBox`). It re-reads the profile after and hands anything else
  to the person. `test/tidy.test.ts` walks a made-up profile's menu and box, and again with bare boxes.
- **On its own, only from the list, only what you let it.** The runner (`src/auto/run.ts`) does only the kinds on
  your list for today that the list says it does for you (its `auto`), in the window it opened, one step per alarm
  (`chrome.alarms`), with its state in the extension's storage. It presses Add friend and Confirm the way tidying
  presses (`AUTO_PLANS`, a button under their name, Confirm in the menu Respond opens), Like only on the first post
  on the profile that's theirs and isn't liked yet, and types a comment only in the post's own box, never a reply's,
  sending it with its button or Enter (`src/facebook/auto.ts`). Its presses aren't the person's, so the content
  script doesn't notice them; the runner notes each one itself, marked `auto`. It sends a message only once
  HandsFreeOS says it's OK'd (`outreach.send.*`, `workLeft`): it drafts it with the AI after looking the person up in
  its own window, queues it, and sends what's OK'd in their chat in Messenger, or the chat window their profile's
  **Message** opens, typing only into that chat's box and leaving one with writing in it alone (`writeMessage`). When
  the person sends a few short texts (their voice, on to start), each part between blank lines goes as its own text, a
  few seconds apart, as long as typing it takes (`messageParts`, `partPauseMs`); once one has gone the message counts
  as sent, and its line says if a later one didn't. A message it couldn't send is reported as not sent, with why, and
  never tried again that day. A reply's draft says
  whether the AI found it simple, which with **Replies** (b) lets it go by itself; HandsFreeOS decides
  (`goesAsItIs`), and holds back any reply to someone who needs the person.
  `test/auto.test.ts` walks a made-up profile, post, chat and chat window.
- **A warning stops the day.** The extension keeps the day's warnings itself (`hfos.warned`), so the runner and the
  asks on Facebook refuse to start, or stop, even when HandsFreeOS can't be reached.
- **Asks one at a time, from HandsFreeOS only.** Only the computer that works takes one, and only the person's own;
  an ask and a step of the runner's never go at once (`inTurn`). Its line goes at most every 20 seconds, its end
  keeps its moment and command id, and a step handed over waits half an hour at most. The panel's buttons only answer
  the ask under way; they never start one.
- **Saving only when asked in HandsFreeOS; steps noted as they happen.** Nothing is saved until the person asks for it
  in HandsFreeOS, or lets the extension work on its own, but for what the two switches send as they go. The four
  steps are the exception, noted with `outreach.touch.save` as they're taken, and adding nobody to Contacts. Both go
  through the add-on's commands like any other client: `x-hfos-client: extension`, its version in
  `x-hfos-app-version`, and a command id and moment on every save, so the API can hold old builds to
  `MIN_EXTENSION_VERSION` and the audit log says "via browser extension".
- **Friends are each person's; Don't pitch is the business's.** Where your Facebook stands with someone (friends,
  asked, deleted) is kept for you alone, while the Don't pitch list is shared and says who added each person
  (`outreach.friend.set`). Older news never undoes newer: a list saved before an answer leaves the answer standing.
- **A step is counted once.** It gets its command id and moment when it's noted and keeps both while it waits, so
  sending it again gets the first answer (`src/hfos/noting.ts`). Waiting steps live in the extension's storage and
  go oldest first; one HandsFreeOS refuses is let go and shown as **Not saved**, with why.
- **Steps are found like pages are read:** by the button's label, the links around it and page order, never class
  names. `test/actions.test.ts` takes each step on the hand-written pages, and again with bare boxes around everything.
- **The background worker holds the sign-in.** It keeps the Supabase session in the extension's own storage and
  makes every call to HandsFreeOS (`src/hfos/session.ts`); the panel asks it (`src/hfos/messages.ts`), and it
  answers only the extension's own pages. The offscreen page answers only the extension's messages meant for it.
  One holder means panels in two windows never refresh the sign-in at once.
- **Cut to fit before sending.** `src/hfos/saves.ts` builds each save from the read, cut to what the commands take
  (`packages/core/src/addons/outreach/limits.ts`, which has no zod so the extension stays small), and keeps a chat's save
  under the API's 256 KB limit by sending the newest messages that fit.
- **Each reader checks itself.** When a page should have something and the reader finds none, it says so and asks for
  the outline (`src/facebook/page.ts`).
- **An outline never holds what a person wrote.** `test/outline.test.ts` checks that no name, message or id survives.
- **No remote code.** Everything ships in the bundle; the stores forbid downloading code.
- **No real Facebook pages in the repo.** The pages in `test/fixtures` are written by hand to look like Facebook's.
  A saved real page holds other people's names and messages, so tune the readers from outlines instead.

## Where things are

| Path                                        | What it is                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/facebook/`                             | The readers: one file per kind of page, the steps, the address rules, Facebook's words, the outline, the download steps, what to look at as you go     |
| `src/content.ts`                            | The script in each Facebook tab: reads the page when asked, looks at the tab in front of you as it settles, and notices your steps                     |
| `src/panel/`, `public/`                     | The side panel: `account.ts` signing in, `status.ts` Right now with Start, Stop and an ask under way, `waiting.ts` Waiting for you                     |
| `src/asks/run.ts`                           | What you ask of it from HandsFreeOS: taking each ask, doing it with its job, handing steps to you, and how it ended                                    |
| `src/hfos/asks.ts`                          | The asks' side of HandsFreeOS: take, progress, end (waiting with no connection), reply and stop                                                        |
| `src/jobs/`                                 | The jobs that go page by page: the file and bringing it in, tidying, the look-up, friends, groups and members, Find posts, Read my chats, checks       |
| `src/offscreen.ts`, `public/offscreen.html` | The offscreen page that opens the zips in your downloads for Bring them in                                                                             |
| `src/hfos/looked.ts`                        | What the tab in front of you read as you went: warnings noted, chats and posts sent                                                                    |
| `src/auto/`                                 | On its own: what it does next and when (`plan.ts`), the runner (`run.ts`), the once-a-day jobs (`daily.ts`), and taking turns with asks (`turns.ts`)   |
| `src/hfos/`                                 | HandsFreeOS: the sign-in and calls (background), the saves, the steps noted, Facebook's times, its zips in downloads                                   |
| `src/hfos/follow.ts`                        | Your settings from HandsFreeOS, and the live channel's news: loaded at sign-in and each step, and followed live                                        |
| `src/hfos/setup.ts`                         | The first run: telling HandsFreeOS it's signed in, and opening HandsFreeOS's setup for a first-timer                                                   |
| `src/hfos/live.ts`                          | What it tells HandsFreeOS: this computer, the beat, the feed of steps, Start my day and Stop for today, and which computer works                       |
| `src/hfos/waiting.ts`                       | Waiting for you: the number on the icon and Chrome's pop-ups                                                                                           |
| `src/tab.ts`                                | The tab a job works in, in view or in a window of its own                                                                                              |
| `src/background.ts`                         | Opens the side panel, answers its asks, notes the steps the tabs tell it, follows your settings and your day, beats, and wakes the runner and the asks |
| `scripts/build.mjs`                         | Bundles with esbuild and writes `manifest.json`, with the version from `package.json`                                                                  |
| `test/`                                     | The readers and steps on the hand-written pages, the addresses, the outline's hiding, the saves, the jobs and the asks                                 |

## Next

Tidying on its own and joining groups (decisions 29 and 31; docs/outreach.md, the rest of decisions 26 to 35); Social
Outreach's onboarding is built, in HandsFreeOS (decisions 36 and 45). Safari on Mac follows in Phase 2.
