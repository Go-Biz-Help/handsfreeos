# HandsFreeOS Social: the browser extension

The extension that works beside a person on Facebook, on LinkedIn once they turn it on, and later Instagram, for the
Social Outreach add-on (docs/outreach.md). It connects to HandsFreeOS only for businesses that have that add-on on.

**This is a test build (0.76.0), and a bare one** (decisions 43, 59 and 72 in docs/outreach.md). Everything is set
and started in HandsFreeOS; the extension does the work on Facebook. Its side panel shows progress and activity only:
signing in, what it does next with today's steps and **Start my day** and **Stop for today**, how many things need
you in HandsFreeOS (with a link there), each network's line, what it did today, and a link to HandsFreeOS. Needs you
itself, with its messages, chats and buttons, is in HandsFreeOS on the web and the phone.

Signed in, it notes the friend requests, likes, comments and messages you send yourself, with the group you found
each person in, and your answers to friend requests. In the Facebook tab in front of you it reads Facebook's
warnings, and, as your settings say, the chats you open and the posts in a group as you scroll. It works your list
for today on its own, as far as you let it. And it does what you ask of it from Social Outreach's Friends, Groups,
Chats and Today tabs (and the phone's Groups and Chats screens): getting your Facebook file and bringing it in, saving your friend requests, friends list,
groups and their members, finding groups and posts, reading your chats for the AI, checking your friends for good
fits, cancelling old friend requests and unfriending the people you tick, and looking someone up before the AI drafts
to them. It stops for the day on any
Facebook warning, and tells HandsFreeOS what it's doing, so the app shows it live. Its icon shows how many things
wait for you, and Chrome's pop-ups tell you of new ones, as your phone does; a click opens Needs you in HandsFreeOS.
It never sends a message you haven't OK'd, and never clicks, scrolls or changes a page but for what you asked or let
it do.

On LinkedIn, once you turn it on in HandsFreeOS and let Chrome open LinkedIn to it, it notes the invitations to
connect, likes, comments and messages you send yourself, and your answers to invitations; it tells HandsFreeOS who
wrote back, and stops on LinkedIn for the day on any LinkedIn warning. Since 0.40.0 it also does what you ask of it
there from HandsFreeOS, at a person's pace in a window of its own: saving your connections and invitations, checking
your connections for good fits, reading your chats, looking someone up before drafting, reading your profile and
putting your headline in, withdrawing the old invitations you tick, and finding posts with LinkedIn's post search.
Since 0.41.0, once you let it and start your day on LinkedIn, it works your LinkedIn list on its own too, beside
Facebook's and never waiting on it (below, "On its own on LinkedIn"). Since 0.42.0 it gets LinkedIn's copy of your
data (your connections, invitations and messages) and brings it in, as it does Facebook's file. Since 0.43.0 it
puts your helpful post up on your own LinkedIn feed, once you OK it or on its own if you let it, and reads who
engaged with it. Since 0.44.0 its panel no longer lists Needs you or its chats (decision 72): it says how many
things need you, and you OK, change, skip and carry on in HandsFreeOS. Since 0.46.0 its LinkedIn readers and the
steps it notes there are tuned from the owner's page outlines of 16 Oct 2026, his feed and his own profile in
LinkedIn's newer layout (below, "What it reads" and "What it notes"); they still read the older one.

## The networks

Each network is a kit (`src/networks/`; HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md, "How it fits: one
add-on, a kit per network"):
its network from core (`NETWORKS` in `packages/core/src/addons/outreach/networks.ts`: its name, the start of its links,
the shapes of its ids), its sites as Chrome's match patterns, what kind of page an address is, its readers and
warnings, `workUrl`, noting your steps there, what to look at as you go, and the page outline (`src/networks/kit.ts`).
A tab's kit is found by its address (`kitOf`), so the tab reads and notes by its own network's rules, and the
background takes a tab's notes only from a network it knows, as that network's. What differs from one network to the
next is in its kit, never in an `if`.

| Network   | Folder                    | From install? | What it does there                                                                                                                                                    |
| --------- | ------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Facebook  | `src/networks/facebook/`  | Yes           | Everything below                                                                                                                                                      |
| LinkedIn  | `src/networks/linkedin/`  | No: asked for | Reads its pages, notes your steps and who wrote back, looks for its warnings, does what you ask, and works its list on its own once you let it                        |
| Instagram | `src/networks/instagram/` | No: asked for | Still looked at (decision 78): reads only its warnings as you go, and its main pages for **Check Instagram** (0.58.0), trying each step up to its last press (0.59.0) |
| Alignable | `src/networks/alignable/` | No: asked for | Still looked at (decision 78): the same, for **Check Alignable**, from its signed-in pages at /biz, following their menus by their words                              |

**A network that's off runs nothing, reads nothing and shows nothing** (`src/networks/on.ts`). Two things say a network
is on, and both must:

- **HandsFreeOS:** you turned it on in your settings, and your business allows it (`rules.networksAllowed`), as the
  extension follows them (`src/hfos/follow.ts`). Signed out, Facebook stays on, as it always was, and any other network
  is off.
- **Chrome:** LinkedIn's site (`https://www.linkedin.com/*`) is an optional host permission, asked for only once you
  turn LinkedIn on, never at install, so an update never asks everyone again and the extension never runs on a site
  you don't use. While LinkedIn is on in HandsFreeOS and Chrome hasn't allowed it yet, the panel says so in a line
  with **Allow on LinkedIn**, which asks Chrome (Chrome asks only from your own click). Instagram's and Alignable's
  sites (`https://www.instagram.com/*`, `https://www.alignable.com/*`) are the same, with **Allow on Instagram** and
  **Allow on Alignable**.

**A network still looked at** (Instagram and Alignable, decision 78) is read only for its Check, from one reader for
both (`src/networks/looking/`) and each network's site (its addresses, its own words, its warnings and the buttons each
step needs: `src/networks/instagram/site.ts`, `src/networks/alignable/site.ts`). Its script notes none of your steps
and reads nothing as you go but its warnings; HandsFreeOS asks it nothing but its Check (`src/jobs/looking.ts`) and,
on Instagram, reading and writing your own profile (decision 80). The Check
reads its main pages and sends a problem report of each with its outline, and looks for each step's button, pressing
none: Instagram's bio box and Submit, Follow, Message, Like and the box to comment in; Alignable's Connect, Message,
Recommend, Like and a box to comment in. Check Alignable opens the places Alignable's own menu leads to by their words,
never one that signs out, pays, invites, deletes or changes settings. From 0.66.0 (stage 6 of the partners plan) it
then opens what Alignable's steps and Find partners are built from next: your town (from your business's address), a
search for businesses, a forum question a page linked to, your connection requests (My Network's Requests) and a chat
with one of your connections (a connection's Message), writing nothing. Connect isn't opened: its link may send the
request. Each is built out from what its Check sends back. From 0.67.0 Alignable has readers of its own
(`src/networks/alignable/read.ts`), built from that Check's outlines: a search's businesses, your connections, the
posts on a group's page (a town opens at its own group, `/groups/<town-st>`), a forum question's answers and its box,
a business's page (its pitch, About Us, ideal customer and ideal partner) and Messages. Each of the Check's notes says
how many of each they found, never what they say, so the next Check shows whether they read the real pages. 0.68.0
reads My Network's Requests too, waits for your town's posts to load, and presses About Us's Edit on your profile,
where Alignable opens its editor, closing it with nothing written. From 0.69.0 it notes your own steps on Alignable as
you take them (`src/networks/alignable/actions.ts`), as on Facebook and LinkedIn: a Connect (which on Alignable makes
the request at once), a post's or an answer's Like, Send in a forum question's box or a reply's, and a message, each
to the business it's for by Alignable's id for it. It never keeps what a comment or a message says. From 0.70.0
Check no longer presses About Us's Edit: Alignable emails you a code before it lets you change your profile, so
each press sent you an email. It reads that code's box when it's open, for HandsFreeOS to ask you for the code.
From 0.71.0 Get ready reads your Alignable profile for the AI's check, and **Put this one in** puts the About Us the
AI wrote on it: Alignable's Edit asks for the code it emailed you, your phone says to look in your email, you type it
in HandsFreeOS, and the extension puts it in and goes on (`src/networks/alignable/own-profile.ts`, decision 82).
From 0.72.0, when no code comes in 30 minutes, it hands the step over with "No code came in 30 minutes" rather than
failing it: HandsFreeOS asks you to **Try again**, and when you do, it opens your profile again and presses Edit, so
Alignable emails a new code (`src/jobs/looking.ts`).
From 0.73.0 it takes Alignable's asks from HandsFreeOS too (partners stage 6c, part 4; `src/jobs/alignable/`):
**Save my connections** opens My Network, switches it from Ally's picks to all your connections, reads them to the
end and saves them; **Check my connection requests** saves the ones you've got from its Requests; **Check my
connections** and **Research** open each business's page and read it for the AI's check, 30 a day to start; and a
look-up reads a business's page before the AI drafts to it. It presses nothing on Alignable but My Network's tab of
all connections and a list's own Show more. Check Alignable also opens a chat with messages in it from Messages'
side, so its chat reader can be built from that next.
From 0.74.0 **Find posts in your town** opens your town's page on Alignable (the town in your own profile's address),
reads a few screens of its posts and forum questions, and sends them for the AI's check
(`src/jobs/alignable/posts.ts`). It presses nothing there.
From 0.75.0 it notes a recommendation you write on Alignable, once its page sends what you wrote, to the business it's
for (`src/networks/alignable/actions.ts`), and Check Alignable opens a recommendation's page, never sending it.
From 0.76.0 reading your Alignable profile counts the recommendations it shows, for Get ready's "at least 5".

The background keeps which networks are on, and Chrome's leave, in `hfos.networks`, works it out again when your
settings or who's signed in change and when you allow or take back a site in Chrome, and registers LinkedIn's script
(`chrome.scripting.registerContentScripts`, the same `content.js`) only while both say so; it's unregistered as soon as
either stops (`src/networks/scripts.ts`). A LinkedIn tab that was open before then gets it when it's next reloaded. A
tab whose network was turned off since it loaded notes nothing, reads nothing, and answers only that it's off.

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

On LinkedIn (`src/networks/linkedin/`, read only while LinkedIn is on): a profile (yours too, with its Featured and
latest posts for Get ready's check, `own-profile.ts`), your connections, people search, your invitations both ways,
the feed, post search, a post's own page, a group, messaging's list and an open conversation, notifications, a
company's page and its About (`company.ts`, for a look-up), and LinkedIn's warnings. LinkedIn writes much of its text twice, once shown and once
for screen readers (in its newer layout often the screen readers' copy first): the readers read what's shown. As you
go, only its warnings are looked at for now.

**LinkedIn's newer layout** (0.46.0, tuned from the owner's page outlines of 16 Oct 2026; the pages rebuilt from
them are `test/fixtures/linkedin-feed-2026-10.html` and `linkedin-own-profile-2026-10.html`) is plain `p`, `span`
and `div` with `data-testid`s. The readers go by:

- **Posts** (`posts.ts`): each a `div role="listitem"` in the feed's `div role="list" data-testid="mainFeed"` holding
  one post's menu ("Open control menu for post by …"). Its author is the one that menu names, linked in its header;
  where someone else is named above (liked, reposted, commented on), LinkedIn draws a line (`hr`) and the author is
  under it. A group's post names its author without a link: read with their name and no profile, its own link from
  the group link's `highlightedUpdateUrn`. Its words are its `expandable-text-box`, all of them (its "…more" only
  shows them); its counts the numbers in its bar's reaction button and Comment; the line under the author's name is
  their headline. Its bar (`barOf`): the post's own Comment, and before it the reaction button, or the button before
  the reactions menu (one that opens a menu). Comments aren't articles there: each is the box of a Reply after the
  bar. Promoted posts, and company and showcase pages', are read as theirs.
- **Your profile** (`profile.ts`, `own-profile.ts`): the name is the top card's `h2`; the headline the first line
  under it that isn't a link ("Add a verification badge" is); the photo a picture in the top card labelled with your
  name or as a profile photo, its own label or the box's around it, and the banner one labelled as a background,
  banner or cover (`picturesOf`); the About its `expandable-text-box` (not "Top skills" under it); each role under
  Experience a link holding its lines (title, company · how, dates, place), and a company with several roles its own
  link with its roles in a list after it, each read. Activity's "You haven’t posted yet" is no post. Nothing is
  pressed to read any of it.

The words LinkedIn's outline hid there and the readers now name (the reaction button's "Reaction button state: like"
and "… no reaction", "Open reactions menu", "Feed post", "Text editor for creating comment", "Edit intro",
"Background image") are a best reading; the readers never depend on them where they can go by structure, and the
outline shows them as they are (`src/networks/linkedin/outline.ts`) so the next one confirms them.

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
It shows progress and activity, and leaves the rest to HandsFreeOS, in HandsFreeOS's look (decisions 59 and 72).
From top to bottom:

- **The top bar**: the business it works for, and how it's doing (working, waiting for the next step, stopped,
  standing by) as a coloured chip, the same words and colours as HandsFreeOS's.
- **Signing in** (`src/panel/account.ts`): **Send me a prompt** first (below, "Signing in with a prompt"), with
  **Use an emailed code instead** one click away; or, the way the phone app does, an emailed 6-digit code or a
  password, for an account that already exists (new accounts start on the web), under the first run's three steps (sign in here, open
  Facebook in this window, pick your groups and limits in HandsFreeOS). It then works for one business, picked in the
  panel when there are several. Only businesses where Social Outreach is on and you have **Use Social Outreach** are
  listed; with none it says there's nowhere to work, and if Social Outreach is turned off it says so and the business
  leaves the list.
- **Next up** (`src/panel/status.ts`): what it's doing or does next, with when; why it isn't working when it isn't
  (another computer works for you, noting is off, you do everything yourself); Facebook's warning that day; a warning
  when your own steps today go past a daily limit (`pastLimitWords`: the limits count, they don't stop); today's steps
  against the daily limits, as bars, from `outreach.live`; **Start my day**, and **Stop for today** while the day
  goes, with HandsFreeOS's words when it refuses one; and anything you asked of it from HandsFreeOS while it goes,
  each network's on its own line with what it's doing and **Stop**. A step it hands you says what to do, then "When
  you’ve done it, press Carry on in HandsFreeOS → Needs you." (", or Skip to leave this person." for someone you
  ticked), with **Open Needs you**: Carry on and Skip are pressed there, never in the panel. Until you're ready
  (docs/outreach.md, decision 63), Next up is **Get ready for your best results** instead: the main offer, a
  playbook's niche, your profile and your numbers, each ticked as it's done, from `outreach.readiness`, with **Get
  ready in HandsFreeOS** (0.31.0). What only reads still goes meanwhile, and replies to people who wrote to you.
- **What needs you** (`src/panel/needs.ts`), one line under Next up while anything waits: "3 things need you in
  HandsFreeOS" ("1 thing needs you in HandsFreeOS" for one), a link to Needs you on Today in HandsFreeOS. The count
  is the icon's (below, "Needs you: the number and the pop-ups"); nothing shows when none wait. Nothing waiting is
  listed or answered in the panel (decision 72): no messages, chats, replies, steps or friend requests.
- **Each network's line** (`src/panel/networks.ts`): **Allow on LinkedIn** while Chrome hasn't let it on there, a
  network's warning that day, and LinkedIn's runner's line.
- **Done today**: the newest of the day's steps, as HandsFreeOS keeps them, with **See all**.
- **At the foot**: your settings in one line, the hours and training wheels in it, with **Change in HandsFreeOS**;
  who's signed in, with **Sign out**; **Open HandsFreeOS**, which opens Social Outreach's Today for the business; and
  **Something look wrong on this page? Tell us**, folded away, with **Copy page outline** and **Save page outline**
  (below, "When it reads a page wrong").

**Signing in with a prompt** (20261027002910). The person types their email and presses **Send me a prompt**; the
panel shows a 2-digit number. Their phone gets a push (`extension_sign_in`), and any HandsFreeOS tab open in front of
them asks "Signing in to the extension on Chrome? Pick the number you see." with three numbers. The right one signs
the extension in within a couple of seconds; a wrong one, or **That wasn’t me**, stops it for good.

- **The background holds the secret** (`src/hfos/prompt.ts`). Starting (`POST /public/extension-sign-in/start` on the
  worker) answers a request id, the number, a random secret and when it ends; the secret stays in the extension's
  session storage and only its hash is kept in HandsFreeOS. The panel asks every 2 seconds
  (`hfos-prompt-check`), and the background collects with the secret (`…/collect`).
- **Only the worker makes the sign-in.** Once the right number is picked, the first collect with the secret gets a
  one-time token: the hashed token of a magic link the worker makes with its admin key (`generateLink`, never
  emailed). The background redeems it with Supabase Auth (`verifyOtp({ token_hash, type: 'email' })`), which makes
  this extension's own session; the token is stored nowhere. The API never holds the admin key.
- **Two minutes, once.** A request ends after 2 minutes, is answered once, and is handed over once. A new prompt for
  the same email cancels the one before.
- **Nobody learns who has an account.** Starting answers the same for any email; one with no account simply never
  gets answered. Starts are limited per address and per email.
- **Nobody signed in anywhere?** Nothing pops up, the prompt runs out, and **Use an emailed code instead** still works.

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
was to, never what you wrote. For a like or comment it makes on its own, it also notes what the post said, the AI's
comment and why the AI picked that post to like, for the Results tab's **Posts liked and commented on**.

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

**On LinkedIn** (`src/networks/linkedin/actions.ts`), while LinkedIn is on, the same steps, noted as LinkedIn's
(`platform: 'linkedin'` on every save from a LinkedIn tab), by the same queue:

| Step                  | Noted when you…                                                                                                                                                                                                                         | To                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Invitation to connect | press **Connect**, then **Send without a note** or **Send** in the box LinkedIn opens; or Connect, when it sends at once                                                                                                                | the profile it's at the top of (or under its **More**), or the one person its card names         |
| Like                  | press **Like** on a post or a comment, or pick a reaction over a post that has none of yours (not **Unreact**); in LinkedIn's newer layout, its reaction button, or a reaction from the menu beside it, once the button shows one given | whoever wrote the post (the one under the line where someone else is named above) or the comment |
| Comment               | press **Comment** (or **Post**, **Reply**) under a box with something in it; in the newer layout, any of the box's own buttons, once the box empties                                                                                    | whoever wrote the post, or the comment you're replying under                                     |
| Message               | press **Send** in a conversation in LinkedIn messaging, or in a chat window over a page                                                                                                                                                 | who it's with, with the conversation's id                                                        |
| Accept                | press **Accept** on an invitation you got, in My Network or at the top of their profile                                                                                                                                                 | who sent it: as Confirm on Facebook                                                              |
| Ignore                | press **Ignore** on one                                                                                                                                                                                                                 | who sent it: as Delete on Facebook                                                               |

- **Noted once it went.** LinkedIn mostly opens a box after Connect (Add a note, Send without a note): the invitation is
  noted when that box sends it, with a note or without, and never for what the note says. When no box opens, it's
  noted a moment later if the button no longer says Connect; a box left for 5 minutes, or one that names someone
  else, notes nothing. Enter in a comment's or a message's box counts only once the box empties after it, since in
  LinkedIn's boxes Enter may only start a new line; pressing the button after notes it once.
- **LinkedIn's newer layout** (0.46.0, from the owner's outlines of 16 Oct 2026; the owner's like then wasn't noted,
  as the extension looked for "React Like", which that layout doesn't say). Its reaction button is labelled by its
  state ("Reaction button state: no reaction", a best reading), so it's found by where it is, in the bar holding the
  post's Comment, before the reactions menu (a comment's, before its Reply), and looked at again a moment after the
  press (`LIKE_LOOK_MS`): a like is noted when the count in it went up, or its label changed from none of yours to one
  (its words when they say, else how the other posts' buttons read), never when one was taken back or changed to
  another; if LinkedIn draws the post again, it's found again by its menu. A reaction picked from the menu beside it
  is looked for the same way after the next click. The comment box (LinkedIn's tiptap `div role="textbox"`) is sent
  by a button whose words aren't known yet: a press on any of the box's own buttons with writing in it is noted once
  the box empties, and only the last press before it did. A Reply under the box, with a comment and its writer
  between, is never the box's.
- **Left out:** invitations to follow a page, go to an event or read a newsletter; a company's or a showcase page's
  post, and one LinkedIn was paid to show ("Promoted", "Promoted by …"); a group's post whose author isn't linked; a
  chat with more than one other person; a step to yourself (the name on the top bar's **Me**, or your profile beside
  the feed's **Start a post**); groups, which aren't noted with a step there yet.
- **Who wrote back:** messaging's list, as you look at it, and the conversation open beside it, when the last line
  isn't yours (`src/networks/linkedin/replies.ts`); never a group, and never what they wrote. Sent as LinkedIn's.

Social Outreach's Live and Activity tabs show today's steps against the daily limits and who wrote back. **Note my
steps on Facebook**, in your settings in HandsFreeOS, turns noting off and on; it starts on. When HandsFreeOS can't
be reached, steps wait in the extension, up to 200, and go in order when it's back. Steps in the extension's own
windows and tabs are its own, never noted as yours.

**Who wrote back** (decision 22): while noting is on, each tab looks at the chats on the page as it changes, at most
every 10 seconds and not in the 20 seconds after you send one. On Facebook, Messenger's list (a line that doesn't
start "You"), the chat open on its page, and small chat windows over any page, where the last message is theirs
(`src/networks/facebook/replies.ts`); on LinkedIn, messaging's list and the conversation open beside it (above). The
background sends who, as the tab's network's (the chat's id or their profile, never what they wrote), only chats from
the last two days and each at most every 3 minutes (`src/hfos/replies.ts`). HandsFreeOS counts one only when it
answers a message of yours it noted, and tells your phone unless you had that tab in front of you.

## What you can ask it from HandsFreeOS

The buttons on Social Outreach's Friends, Groups, Chats and Today tabs ask your computer to do something on Facebook
(an ask, `outreach.ask.make`; decision 43 in docs/outreach.md). The computer that works for you hears of it within
seconds on the live channel (`src/hfos/follow.ts`), or with its next beat's answer, takes it (`outreach.ask.take`,
the oldest first), does it with the jobs in `src/jobs/` (LinkedIn's in `src/jobs/linkedin/`), and says how it's going and how it ended, which the web
shows under the button and on the Live tab, and the panel under **Right now** (`src/asks/run.ts`,
`src/hfos/asks.ts`). A kind of ask newer than the build on the computer (`ASK_KIND_SINCE`: checking friends 0.21.0,
checking and joining groups 0.22.0, putting a helpful post up 0.24.0, reading your profile and putting your bio in
0.32.0; anything on LinkedIn 0.40.0, `ASK_NETWORK_SINCE`) isn't asked of it: the button says to update the build,
and how. A build that's handed a kind it doesn't know ends it saying so, and goes on to the next ask.

| Button, and where                                                                          | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Where it works, and its pace                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Ask Facebook** (Friends, Let the extension get your file)                                | In Accounts Center's Export your information: keeps only Messages, Friends and Followers, sets All time, JSON and Lower quality, and starts the export; stops if Facebook is making one already                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | A tab you can see; you type your password there                                    |
| **Download my file** (the same)                                                            | Once Facebook has emailed you, presses Download beside the file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | The same                                                                           |
| **Get my chat backup** (the same)                                                          | From ⋯ beside Chats, Privacy & safety, End-to-end encrypted chats, Message storage: downloads the backup from all time without media, for chats newer than the file has                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | The same; you type your PIN there                                                  |
| **Bring them in** (the same)                                                               | Finds Facebook's zips in Chrome's downloads, however they were downloaded, reads them and sends names, dates and each one-to-one chat's latest 20 messages, as the Friends tab's card does (`src/jobs/file-in.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | The offscreen page (`src/offscreen.ts`); needs **Allow access to file URLs**       |
| **Check my friend requests** (Friends)                                                     | Saves the friend requests you've got, a few screens of them (`src/jobs/people.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | A window of its own, 4 to 9 seconds a screen                                       |
| **Save my friends list** (Friends)                                                         | Scrolls your friends list to the end and saves it, 500 at a time                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | The same, up to 150 screens                                                        |
| **Check my friends** (Friends)                                                             | Asks HandsFreeOS who's next (friends you've chatted with first), opens each profile, checks it's them, reads their intro, latest posts and the business page it links to, and sends those lines for the AI (`src/jobs/checks.ts`, decision 46)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | A window of its own, one person every 15 to 30 seconds, up to 40 a day             |
| **Check my groups** (Groups)                                                               | Asks HandsFreeOS which groups are next (yours first, then ones that fit by name), opens each, reads its latest posts, then its About tab (what it's for and its rules), and sends them for the AI (`src/jobs/groups-check.ts`, decision 48)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | A window of its own, one group every 8 to 16 seconds, up to 8 (4 a day on its own) |
| **Find and join more groups**, **Ask to join** (Groups)                                    | Asks HandsFreeOS which groups to join (with none, searches with your playbook's words and checks the best 3 first), presses **Join group**, writes in the AI's answers to its questions, ticks that you agree to the rules, submits, and notes how it went (`src/jobs/join.ts`, `src/networks/facebook/join.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                          | A window of its own, one group every 20 to 40 seconds, up to 3 a day               |
| **OK, post it** (Today, a helpful post)                                                    | Opens the group, presses **Write something…**, types the post you OK'd into the box Facebook opens, presses **Post**, finds it at the top of the newest posts for its link, and notes it (`src/jobs/helpful.ts`, `src/networks/facebook/compose.ts`, decision 50)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | A window of its own, one post                                                      |
| **Cancel the ticked requests**, **Unfriend the ticked** (Friends)                          | Opens each profile you ticked that's still on the lists, checks it's them and where you stand, presses **Cancel request** (or **Friends**, **Unfriend** and **Confirm**), checks it says **Add friend** after, and notes it (`src/jobs/tidy.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | A tab you can see, one person every 20 to 40 seconds, up to 30 and 20 a day        |
| **Save my groups**, **Find groups** (Groups)                                               | Your groups, or a search for groups with the words you gave, scrolled and saved with how each fits your playbooks (`src/jobs/groups.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | A window of its own, 4 to 9 seconds a screen, 8 screens                            |
| **Save a group**, **Save its members**, **Save members of my best groups** (Groups, Today) | A group's admins and moderators read to the end first, then a few screens of its members; the best groups are up to 3 of your Work these, those with fewest saved first                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | A window of its own                                                                |
| **Find posts** (Groups)                                                                    | Your Work these groups (or Maybe, with none), up to 5, each feed scrolled a screen at a time; the posts worth a look go to the AI, and the good ones on Today (`src/jobs/posts.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The same, 6 to 12 seconds a screen, 8 screens a group                              |
| **Read my chats** (Chats)                                                                  | Opens your chats in Messenger one at a time from the list and scrolls it for more, skipping any read in the last day that hasn't changed; group chats are left out (`src/jobs/chats.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | The same, 7 to 14 seconds a chat, up to 150                                        |
| **Draft a message**, **Draft a comment** (Today, while it's online)                        | Opens their profile, reads their intro and latest posts and the business page their intro links to, then has the AI draft with those lines; the drafts come back on the ask (`src/jobs/lookup.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | A window of its own, closed after                                                  |
| **Read my profile** (Today, Get ready)                                                     | Opens facebook.com/me, checks it's your own (**Edit profile**), reads the picture's and the cover's descriptions, the bio, the intro, what's featured and the latest posts, and sends them for the AI's check; HandsFreeOS keeps only the AI's answer (`src/jobs/profile.ts`, `src/networks/facebook/own-profile.ts`, decision 64)                                                                                                                                                                                                                                                                                                                                                                                                                                        | A window of its own, one read                                                      |
| **Put this one in** (Today, Get ready, a bio the AI wrote)                                 | Presses **Edit bio** (or **Add bio**), writes the bio you picked in place of the old one, presses **Save** and waits for it to show, then reads the profile again; with no Edit bio it hands the step to you                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | A window of its own                                                                |
| **Check Facebook** (Settings, Facebook; 0.57.0)                                            | Opens your profile, feed, friend requests (and, after **View sent requests**, the ones you've sent), friends, groups and one of them, a people search, a groups search, your chats, one friend's profile, the profile of someone you sent a request to, your notifications and Download your information, one at a time, and sends a problem report of each with its outline. On the way it tries each step up to its last press, which it never presses: your bio, confirming a request, a post in a group, a comment, a friend request, joining a group, a like, unfriending, a message, cancelling a request and your file; a report of each says what works, and a last one names what doesn't (`src/jobs/checkup.ts`, `src/networks/facebook/tries.ts`, decision 77) | A window of its own, in front for about four minutes                               |

- **A line per network** (the plan's "One runner, one turn"). Each network takes its own asks (`outreach.ask.take`
  with its `platform`), one at a time, in its own window and its own turn (`src/auto/turns.ts`): a LinkedIn ask never
  waits on Facebook's runner or on a Facebook step handed to you, and the reverse. A network's line takes asks only
  while it's on for you in HandsFreeOS and Chrome allows it (`isWorking`); one turned off or taken back since its ask
  was taken ends it at once, saying how to turn it on. The computer that works for you stays one (decision 41).
- **Never beside the runner.** On Facebook an ask takes Facebook's turn: the runner waits ("Doing what you asked from
  HandsFreeOS first") and carries on after. Asks go outside your working hours and after Stop for today too, since
  you're asking now.
- **How it's going:** a new state goes to HandsFreeOS at once, and a new line alone at most every 20 seconds
  (`lineDue`), with no receipt kept. How it ended goes with its own id and moment; with no connection it waits
  (`hfos.ask.ends`, at most 20) and goes with the next beat. Each network's ask under way is kept for the panel,
  Facebook's in `hfos.ask` and LinkedIn's in `hfos.ask.linkedin` (`askKeyOf`), and the panel shows each with its own
  **Stop**; one left there when the extension starts again (Chrome closed mid-way) is ended as lost.
- **Steps it hands to you:** a step it can't find on a network's file pages or a profile it hands to you: the tab
  comes to the front, Chrome pops up, your phone hears "Your computer needs you", and it waits for **Carry on** (or
  **Skip**, for someone ticked), pressed in Needs you in HandsFreeOS on the web or the phone (`outreach.ask.reply`).
  The panel says what to do and to press Carry on there, with a link (decision 72). It hears the answer on the live
  channel, or asks HandsFreeOS for it every 20 seconds. Half an hour with no answer stops it. While Facebook asks for your password or PIN, or LinkedIn for your
  password, it waits for you to type it there; it never types one.
- **Stops:** **Stop**, in the panel or the app; Stop for today, pressed in the panel, the app or the phone, which ends
  Facebook's (the day the beat carries); another of your computers working now, which ends every network's; or a
  network's warning that day, which ends that network's ask before it starts, or at its next page while it goes,
  and never another network's: seen here in any tab, or, for Facebook, on another of your computers (all but
  **Bring them in**, which doesn't open Facebook; HandsFreeOS ends LinkedIn's waiting asks itself on a day LinkedIn
  warned you); or signing in, signing out or picking another business here (`signInChanged`), and it
  checks before each call to HandsFreeOS that you're still the one signed in, to the same business, so nothing of
  yours goes as anyone else's: its end waits until you're back. A stopped ask ends with why and how far it got
  ("Stopped: you pressed Stop for today. Requests cancelled: 2 people.").
- **Only its network's pages:** an ask's tab opens only https addresses of its own network: on Facebook
  www.facebook.com, web.facebook.com and accountscenter.facebook.com, on LinkedIn www.linkedin.com (each kit's
  `workUrl`, checked in `src/tab.ts`, whose tab goes by its kit), so a bad link kept in HandsFreeOS or read off a page
  is refused with plain words and never opened. A tab does only its own network's steps (its kit's `work`); asked
  another's, it says so.
- **Done or not:** an ask is **Done** only when its job did what was asked. Stopped, warned, or unable to (nothing to
  save, HandsFreeOS refusing a save, a page that didn't load) it ends as failed, with the job's words.
- **What it keeps:** `hfos.ask`, `hfos.ask.linkedin` and `hfos.ask.ends` above, and `hfos.facebookFile` and
  `hfos.linkedinFile`: when you asked each network for your file, and which zips were brought in. The offscreen page
  (the `offscreen` permission) is opened only to read the zips and closed once they're in.

### On LinkedIn (0.40.0)

LinkedIn's rules hold for every one (the plan's "The risk, said plainly"): a person's pace, a window of its own,
reading only unless the ask says to press, a stop on any LinkedIn warning (in LinkedIn's words, and LinkedIn's alone),
and nothing to get around LinkedIn's limits or checks (`src/jobs/linkedin/`, `src/networks/linkedin/work.ts`).

| Ask (`kind`)                               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Where it works, and its pace                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Save my connections (`friends`)            | Scrolls My Network's connections slowly to the end (LinkedIn's own **Show more results** where the list stops loading) and saves them as your friends list, as LinkedIn's (`people.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | A window of its own, 6 to 12 seconds a screen, up to 150 screens                            |
| Check my invitations (`requests`)          | Manage invitations: the ones you've got, then the ones you've sent, each saved as Facebook's friend requests are                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The same, up to 30 screens each                                                             |
| Check my connections (`checks`), Research  | Asks HandsFreeOS who's next on LinkedIn (`outreach.checks.next`, `platform: 'linkedin'`), opens each profile, checks it's them by the name in its address or LinkedIn's id, reads it and sends the lines (`outreach.check.look`); one page each (`checks.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | A window of its own, one every 15 to 30 seconds, on LinkedIn's own 40 a day: a look is seen |
| Read my chats (`chats`)                    | Opens your conversations in LinkedIn messaging one at a time from its list, and sends each as LinkedIn's, with its thread id (`../chats.ts`, `LINKEDIN_MESSAGING`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | A window of its own, 7 to 14 seconds a chat, up to 150                                      |
| Draft a message (`lookup`)                 | Their profile, then the About of the company their role links to: two pages, then the window closes before the AI drafts (`lookup.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | A window of its own, closed after                                                           |
| Read my profile (`profile_read`)           | linkedin.com/in/me/, checked it's yours, scrolled to its foot and back so LinkedIn draws every part (0.45.0), each part it still holds an empty place for kept in view till it's drawn, up to 6 seconds each (0.50.0: its newer layout fetches About, Experience and the rest only once their places are seen), with its window in front while it's read, then yours back (0.47.0: Chrome draws nothing in a window hidden behind another), read as `outreach.profile.check` takes it: the headline as the bio, the About, Experience as the intro (every role), Featured and the latest posts, and whether it shows a photo and a banner; in LinkedIn's newer layout too (0.46.0, "What it reads"), pressing nothing (`profile.ts`, `src/networks/linkedin/own-profile.ts`) | A window of its own, one read                                                               |
| Put this one in (`profile_edit`)           | Presses the pencil by your name (**Edit intro**, or the link to `/in/<you>/edit/intro/` whatever its label: 0.50.0), types only into **Headline** in the box it opens (a box to write in, named by its label or, in LinkedIn's newer box, by the line just above it: 0.51.0), presses that box's **Save**, and checks the headline under your name; anything it doesn't expect it hands to you, never guessing, and its report says which step failed and lists the box's fields as the outline names them (0.52.0, which also pastes the words when typing doesn't take); since 0.53.0 a field's line above it names it however many boxes LinkedIn wraps it in                                                                                                             | A window of its own, brought to the front if it hands the step over                         |
| Withdraw the ticked invitations (`cancel`) | On Sent invitations, finds each one you ticked by the link to their profile, scrolling for it, presses **Withdraw** and the box's **Withdraw**, checks the row is gone, and notes it; one not on the list, read to its end, answered already (`withdraw.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | A tab you can see (decision 17), one every 20 to 40 seconds, up to LinkedIn's 20 a day      |
| Find posts (`posts`)                       | LinkedIn's post search, latest first, with your playbooks' words (HandsFreeOS picks them: the quoted words in their signs, then their words for groups), a few screens each; posts by people go to the AI, in no group (`posts.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | A window of its own, 6 to 12 seconds a screen, 3 screens a search                           |
| Put up your helpful post (`post`, 0.43.0)  | The one you OK'd, on your own feed: opens it, presses **Start a post**, types the post into the box LinkedIn opens, presses that box's **Post**, takes its link from LinkedIn's **View post** (else finds it among your own posts by its words), and notes it as LinkedIn's (`helpful.ts`, `src/networks/linkedin/compose.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                               | A window of its own, one post                                                               |
| Check LinkedIn (`checkup`, 0.48.0)         | Opens your profile, feed, connections, a people search, a posts search, your messages and one connection's profile, one at a time, reads each, and sends a problem report of each with its outline (`checkup.ts`, decision 74). Since 0.52.0 it also tries each step on the way up to its last press, which it never presses: the headline, a post, a comment, connecting, a message, a like, withdrawing and the data file; a report of each says what works, and a last one names what doesn't (`tries.ts`, decision 76). Since 0.53.0 messaging is also tried on the page Message leads to when nothing opens on the profile, and a try that opens something takes its outline before closing it                                                                          | A window of its own, in front for about three minutes                                       |
| Ask for my file (`file_request`, 0.42.0)   | On LinkedIn's **Get a copy of your data** (Settings, Data privacy): picks **Want something in particular?**, ticks Connections, Invitations, Messages and Profile, presses **Request archive**, and waits while you type your password till LinkedIn says it's preparing it; stops if it's making one already (`file.ts`, `src/networks/linkedin/data.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                   | A tab you can see; you type your password there                                             |
| Download my file (`file_download`)         | Once LinkedIn has emailed you, presses **Download archive** on the same page and waits for Chrome to start the download (and for your password, if LinkedIn asks); if nothing starts, it hands the step to you                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | The same                                                                                    |
| Bring it in (`file_in`)                    | Finds LinkedIn's zip in Chrome's downloads however it was downloaded, reads it (core's `readLinkedInExport`) and saves your connections as your friends list, the invitations still waiting both ways, each since when the file says, then each one-to-one chat's latest 20 messages, matched by name (`outreach.download.save`, chats only)                                                                                                                                                                                                                                                                                                                                                                                                                                 | The offscreen page; needs **Allow access to file URLs**; doesn't open LinkedIn              |

## Reading as you go

In the tab in front of you, panel open or not, on a network that's on, the content script looks at the page as it
settles, every 10 seconds at most (its kit's `lookFor`; Facebook's in `src/networks/facebook/looking.ts`), and the
background notes what it found (`src/hfos/looked.ts`):

- **The network's warnings**, always (below). On LinkedIn, only these for now.
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
  for people you'll ask tomorrow, and their request comes a day after the like. When the post it likes is about their
  work, the AI writes a short comment for it too, which goes under it while the day's comments have room (0.33.0). A
  profile with no post of theirs to like gets its request without one.
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

Before anything else in your day, it saves your own lists (`src/auto/lists.ts`; docs/outreach.md, decision 60): your
friends list, the friend requests you've got, the ones you've sent (it presses **View sent requests** on your friend
requests page, and nothing else), and your groups (Save my groups, `src/jobs/groups.ts`). The first time, your day
waits until all four are saved and your groups are checked (Check my groups, `src/jobs/groups-check.ts`, up to 4), and
it says so ("Saving your friends list first…"); one that goes wrong is tried again in a few minutes. Then it works out
Tidy up's suggestions and checks your friends for good fits once. After that it saves the requests again each morning,
and your friends list and groups once a week; the groups are checked by the daily group checks. While it gets ready,
the panel's Next up shows each step as a checklist (Save your friends list, Save friend requests you got, Save friend
requests you sent, Save your groups, Check your groups, Work out who to unfriend, Check your friends for good fits):
each is ticked once done, and the one under way shows its progress ("Reading your friends… 1,240 friends so far.",
"3 of 8 groups checked."). The runner keeps the step under way (`beforeNow`) and the lists as HandsFreeOS last said
(`lists`) in its state for it; HandsFreeOS and the phone show the same checklist from `outreach.live`. Each beat says
the step under way (`doing`), so they show its count under that step, sent every few seconds while it runs (0.30.0).

With **Once a day** ticked, the first thing it does each working day, or after **Start my day**, is fill your list, a
job at a time, a minute or few apart, in its window (`src/auto/daily.ts`, `src/jobs/`): it saves the friend requests
you've got (Friend requests, loading a few screens of them); checks up to 4 of your groups for your people (Check my
groups); while **Join good groups when my groups run low** is on and your groups have less than a week of people left
to reach, asks to join up to 3 good groups (the only thing it presses here); the admins and moderators of up to 3 of your Work these
groups (the ones with fewest saved first), read to the end, then a few screens of their members (a group whose admins
don't load to the end waits for another day, so nobody who runs it is suggested); Find posts in those groups; Read
my chats, up to 60 a day; Check my friends, the day's 40; Find partners (0.64.0, decision 81), up to 15 people who
could partner with you, read as the checks read friends with how many follow them, for the AI's partner check
(`src/jobs/partners.ts`), while your business has a playbook whose goal is Find partners. Before it reads anyone,
Find partners does today's searches for partners (0.65.0, stage 4 of the partners plan, `src/jobs/partner-search.ts`):
up to two a day, with the partner playbooks' words, each the same way once a week at most: Facebook's post search,
whose writers may be creators your customers follow, and its people search, who may run businesses with the same
customers, three screens of each. It sends everyone each showed, with the lines under their names, to HandsFreeOS,
which keeps the ones not found already to read next. And, last, it asks for
today's helpful post and reads who commented on and reacted to yours up in the last fortnight (`helpfulDaily` in
`src/jobs/helpful.ts`): each a warm lead on your list. Its line says what each found. They only read and save, as the
same asks from HandsFreeOS do, but for asking to join.

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
`src/networks/facebook/auto.ts`, `src/panel/status.ts`). On Today in HandsFreeOS what it does says **Done on its own**, and
your phone's morning push leaves those out. What you ask of it from HandsFreeOS goes first: the runner waits for it
and carries on after.

Your partners' steps (0.64.0, decision 81) come from Today's own part for them (`partners`), after your customers' of
each sort: a like on a post of theirs while it may like on its own (**Warm up a partner**, as a like before a friend
request, with no friend request after it), then their messages, which it drafts and which each wait for your OK on
their own, never **Approve all**: the ask about partnering, follow-ups, the details with your partner link after a
yes, and replies. Once you OK one, it sends it like any message (`workLeft` in `src/auto/plan.ts`); LinkedIn's runner
does the same there.

### On its own on LinkedIn (0.41.0)

LinkedIn's runner (`src/auto/linkedin.ts`; the plan's "LinkedIn, part by part", 5) is its own: its own line and turn
with LinkedIn's asks (`src/auto/turns.ts`), its own window, alarm (`hfos-auto-linkedin`) and state
(`hfos.auto.linkedin`, whose line the panel shows under LinkedIn), so Facebook's runner never waits on it, nor it on
Facebook's. Your LinkedIn choices in HandsFreeOS say what it does (`settings.networks.linkedin`).

- **Only while LinkedIn's day is started:** you press Start my day for LinkedIn in HandsFreeOS or on the phone, and
  the beat brings it (`days.linkedin` in `outreach.live.beat`'s answer). Stop for today on LinkedIn ends what it's
  doing at its next page, and a LinkedIn ask under way too. It works only while LinkedIn is on and Chrome allows it,
  noting is on, this computer is the one that works, and your LinkedIn Sending choice isn't Off.
- **Lists first** (decision 60): before LinkedIn's first day it saves your connections, then the invitations you've
  got and those you've sent, each to its end, works out the old invitations to withdraw and checks your connections
  once (`src/auto/lists.ts`, `outreach.lists` with `platform: 'linkedin'`); then the invitations each morning and the
  connections weekly.
- **Once a day,** with **Once a day** on for LinkedIn: your invitations, your connections checked (40 profiles a day:
  each look is seen), your chats read for the AI (60 a day), posts found with LinkedIn's post search, with your
  playbooks' words (`outreach.posts.words`), Find partners (0.64.0), which first does today's searches for partners
  (0.65.0, `src/jobs/linkedin/partner-search.ts`): post search, the latest first, keeping whoever wrote the posts
  (never a company's page) with the headline under their name, and people search, two pages of it by its address, as
  LinkedIn limits a free account's people searches; and, last, today's helpful post for your feed asked for
  (`outreach.helpful.ask` with `platform: 'linkedin'`) and who commented on or reacted to those up in the last
  fortnight read (each a warm lead on LinkedIn's Today, `outreach.helpful.engaged`).
- **Today's helpful post,** when your LinkedIn posting choice is **On its own**: put up on your own feed once the AI
  has written it, as an OK'd one is (`src/jobs/linkedin/helpful.ts`).
- **Your LinkedIn list for today** (`outreach.today` with `platform: 'linkedin'`), the kinds it does on its own:
  a look at their profile and a like on the first post of theirs nothing rules out (never one about grief, illness or
  trouble; one liked already counts), a day before the invitation; an invitation to connect **without a note**
  (Chris: Connect, or Connect under More, then **Send without a note**; a box that asks for more, like their email, is
  left for you); a comment in the post's own box with the AI's draft; and the messages, drafted after a look-up of
  their profile and their company's page, and sent once OK'd in LinkedIn messaging, in their conversation or the window
  their profile's **Message** opens, typing only into that conversation's box (`src/networks/linkedin/auto.ts`).
  Invitations they sent you are left for you to accept, and old invitations are withdrawn only when you tick them
  (your ask).
- **At LinkedIn's pace:** 2 to 6 minutes between steps, inside LinkedIn's limits, which HandsFreeOS keeps (its list
  holds only what they have room for, the week's 80 invitations among them).
- **A LinkedIn warning** stops it for the day, and only it: Facebook's runner goes on.

Each step is noted as the extension's own (`auto`), as LinkedIn's. A step it couldn't do goes to your Needs you, as
Facebook's do.

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

## Needs you: the number and the pop-ups

**Needs you** is on Today in HandsFreeOS, on the web and the phone (decisions 40, 42, 59 and 72 in docs/outreach.md,
`outreach.waiting`, the list once called Waiting for you): something you asked of your computer that needs you
(**Carry on**, **Skip**, **Stop**), replies handed over to you, messages waiting for your OK, each under the chat so
far (with **Approve all**), steps the extension couldn't do and hands to you (**I did it** or **Let it go**), and
friend requests to decide (**Leave it**). Since 0.44.0 the extension never lists it or answers any of it (decision
72, "The extension shows progress and activity only"): it counts it and tells you of it. The background keeps the
count (`src/hfos/waiting.ts`), and the panel says it in a line (`src/panel/needs.ts`):

- **The number on its icon** is everything waiting (`chrome.action.setBadgeText`, "99+" past 99). It's asked again a
  moment after a change of yours heard on the live channel (a message drafted, OK'd or sent, a step noted or handed
  over, a request answered), one HandsFreeOS made itself (a download brought in), or a change to your pushes, hours
  or training wheels by anyone (an owner may change yours); when the panel opens, after signing in, and every 10
  minutes with nothing heard (the `hfos-beat` alarm). Signed out, or with Social Outreach turned off or out of your
  reach, there's none; with no connection, the last number stays.
- **The panel's line**, under Next up: "3 things need you in HandsFreeOS" ("1 thing needs you in HandsFreeOS"), the
  icon's number, as a link to Needs you (`outreachPath(…, 'waiting')`, which opens Today, at its `#needs-you`, from
  `src/hfos/needs-you.ts`). Nothing shows when none wait, or while the count kept isn't for who's signed in and the
  business they save to, so picking another business never shows the last one's.
- **Chrome's pop-ups** (the `notifications` permission) follow your **pushes** setting, as your phone does: one for
  what's new at most every 2 hours in your working hours (to start), or one for each, with more than 3 at once going as
  one. A reply handed over pops up at once either way, and isn't told again in the bundled one; friend requests never
  pop up. Only the computer that works shows them (src/hfos/live.ts); the first look after signing in tells of what's
  there, replies too, in one pop-up at most. A click, or **Open in HandsFreeOS**, opens Needs you in HandsFreeOS in a
  new tab, never the side panel. A step an ask hands you pops up the same way, and its Carry on is there.
- **Steps it hands to you:** when the runner can't find a button or the box, Facebook shows a different page, or
  Facebook doesn't take a step, it hands the step to you (`outreach.need.note`, from the same waiting list as the
  steps it notes, so it keeps its moment offline), and still tries again another day. A message that didn't go is
  handed over by HandsFreeOS itself. The step noted later, however it was done, takes it off.
- **What it keeps:** the last list (`hfos.waitingFor`) and what a pop-up told of (`hfos.waitingFor.told`), each saying
  whose it is (you and the business). `hfos.waiting` is the steps waiting to be sent (src/hfos/noting.ts), not this;
  Today's count of them leaves out the steps handed to you.

## Each network's warnings

Any warning it sees ("You’re temporarily blocked", "going too fast", a security check; on LinkedIn the weekly
invitation limit, a restricted account, a security check, the search limit), in the tab in front of you or one it
works in, is noted in HandsFreeOS as that network's, once a day for the same words (`src/hfos/looked.ts`,
`outreach.warning.note` with its `platform`, decision 25). The extension then stops on that network for the day:
nothing done on its own there, and no ask there (bringing in your Facebook file still works). It keeps each network's
warnings apart (`hfos.warned`, by network, `src/hfos/warned.ts`; one kept by a build before networks is Facebook's), so
it stops even when HandsFreeOS can't be reached, and a Facebook warning seen on another of your computers stops it
there too. For 7
days your daily limits there are halved, and for 2 friend requests or invitations are off your list. A red note says
so: Facebook's under **Right now**, another network's in its own line in the panel (`src/panel/networks.ts`), and on
the web.

**A warning on one network never stops another** (Chris's rule): a LinkedIn warning stops only LinkedIn, and
Facebook's runner and asks go on; a Facebook warning leaves LinkedIn as it was.

## Load it in Chrome

People on a business's team follow the setup in HandsFreeOS (Social Outreach sends a first-timer there; Settings →
Set up again, or the Carry on line on any tab, opens it), which has the download and these steps in plain
words (decision 71). HandsFreeOS hands out the build itself, made with every deploy: the web app's `build` (and
`dev`) first runs `scripts/download.mjs`, which builds the extension for the HandsFreeOS the web app talks to (its
`NEXT_PUBLIC_` settings, so Vercel's for a deploy and the local stack's on your computer) and zips it with
`manifest.json` at the top to `apps/web/public/downloads/hfos-social.zip`. Nothing to release or commit: bump the
version in `package.json` and the next deploy hands it out (`test/download.test.ts` covers it). The web app lists the
extension among its dev dependencies for that alone: Vercel skips a deploy that touches nothing the web app depends
on, so without it a change to the extension only would never be handed out. The zip keeps its name
from version to version: Chrome knows an extension loaded by hand by its folder, so people unzip a newer one over the same folder
and press the reload arrow, and stay signed in. A business that keeps its own copy pastes its https link under Social
Outreach → Settings → General → **Where your team gets the extension** (on the web or the phone), and
everyone's download is that one instead. When a business starts Social Outreach fresh, the extension
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
4. To bring in your Facebook or LinkedIn file from your downloads, press **Details** on its card and turn on **Allow
   access to file URLs**.
5. For LinkedIn: turn it on in HandsFreeOS (Social Outreach → Settings), then press **Allow on LinkedIn** in the panel
   and **Allow** in Chrome's box. Reload any LinkedIn tab that was open before.

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

**Copy page outline** and **Save page outline**, under **Something look wrong on this page? Tell us** at the foot of
the panel, give the structure of the page beside it, on a network that's on, as plain text: tags, roles, the network's
own words and labels, and the shape of every link (`src/networks/outline.ts`, with each kit's words: Facebook's
`outline.ts`, LinkedIn's `outline.ts`).
Everything a person wrote becomes `[2 words]`, and the people, groups and chats that links lead to become `{1}`, `{2}`…, the same number each time the
same one comes up. With the reader's counts at the top, that's enough to see what Facebook changed and fix the reader.

Since 0.48.0 the extension also sends this itself (decisions 74 and 75, `src/jobs/report.ts`): a problem report in
HandsFreeOS, read by HandsFreeOS's staff on the support desk's **Problem reports** page (`/admin/problems`), of each
page a job read, with what the readers found (counts and the network's own section names) and whether Chrome showed
the page, and the outline when something was missing: every read of your own profile, a step handed to you, an ask
that didn't finish, a step of the day that didn't go, on any network, and every page and step of **Check LinkedIn**. The beat says which
networks Chrome lets it on, so HandsFreeOS can say what to press when an ask waits on one.

## Rules worth knowing before changing anything

- **A kit per network.** Everything that differs between networks is in its kit (`src/networks/`): its sites, its
  addresses, its readers, its steps, its outline. A tab's network is found by its address, never by what the tab
  says, and every save says its network (`platform`), with its links and ids checked against core's kit
  (`NETWORKS[platform].link`, `src/hfos/saves.ts`).
- **A network that's off runs nothing.** LinkedIn's site is only ever an optional host permission, asked for from the
  panel once it's on in HandsFreeOS, and its script is registered only while both say so (`src/networks/scripts.ts`).
  Nothing of the extension's is ever listed in `web_accessible_resources`: LinkedIn's pages look for extensions by the
  files they show. `test/manifest.test.ts` holds this.
- **LinkedIn, said plainly.** Its terms forbid software that automates it, and it restricts accounts it thinks are
  automated. So on LinkedIn the extension notes only what the person presses, reads only as they go or when they ask
  from HandsFreeOS (at a person's pace, in a window of its own, stopping on any warning), and builds nothing to get
  around its limits or its checks. What it does on its own there stays the person's choice, off to start, at
  LinkedIn's lower limits, and only on a day they started on LinkedIn.
- **Pressing on LinkedIn only for what's asked.** LinkedIn's tab presses three things, each only on its own page:
  **Show more results** at the foot of a list that stopped loading (`scrollList`); on your own profile, **Edit intro**,
  then only the **Headline** field and that box's **Save** (`writeHeadline`); and on Sent invitations, **Withdraw** on
  the row of someone you ticked, found by their profile link (`withdrawFor`, `sameMember`), then the box's own
  **Withdraw**. Anything not as expected it stops at and hands to you. `test/linkedin-asks.test.ts` walks each on
  made-up pages, as written and with bare boxes. On its own (`src/networks/linkedin/auto.ts`), it presses Like only on
  a post they wrote, never a comment's (in LinkedIn's newer layout, the post bar's reaction button, found by where it
  is); Connect and **Send without a note**, never typing a note; a comment only in the post's own box, never a
  reply's, sent only with a button among the box's own that says Comment or Post (or "Post comment", "Submit
  comment"), never one past a link; and a message only in the box of the conversation with them, never one with
  writing in it. `test/linkedin-auto.test.ts` walks each, both ways. Your helpful post it types only into the box **Start a
  post** opens, while it's empty, and puts up with that box's own **Post**; who engaged it reads from your post and
  the box its reactions count opens, which it closes (`src/networks/linkedin/compose.ts`,
  `test/linkedin-helpful.test.ts`). For your file, on Get a copy of your data alone
  (`dataPage`), it picks the data files, ticks only Connections, Invitations, Messages and Profile, and presses
  **Request archive** or **Download archive**; the password it leaves to you. `test/linkedin-file.test.ts` walks each,
  both ways.
- **Each network on its own.** A warning or a stop on one network never affects another: each network's warnings are
  kept apart (`hfos.warned`), each network's asks and runner have their own line, window and turn, and each runner
  looks only at its own network's.
- **Addresses first.** Each kit's `urls.ts` (`src/networks/facebook/urls.ts`, `src/networks/linkedin/urls.ts`)
  decides what kind of page it is and what each link points to. The networks change their page code every week and
  their addresses hardly ever, so anything a link can tell, a link tells.
- **Never a class name.** Facebook's and LinkedIn's are scrambled and change constantly. The readers use links, roles,
  ARIA labels, headings and the network's own words (each kit's `vocabulary.ts`), in English for now.
- **Found by its link.** A person, group or chat is found by the link to it, and read from the largest box around that
  link that holds no link to anything else of the same sort (`collectLinked` in `src/networks/facebook/dom.ts`).
- **Page order, not the boxes around things.** An outline leaves out the bare boxes Facebook wraps around everything,
  so a reader never counts on what sits directly inside or beside an element: it goes by what comes before or after
  it on the page (`isBefore`, `elementsAfter`). `test/boxes.test.ts` reads every test page again with a bare box around
  each element and expects the same.
- **Reading only when asked, and noticing only the person.** The content script reads when the background asks (a
  job, the runner), and in the tab in front of the person it looks at the page as it settles for Facebook's warnings
  and, as the switches say, the chat open and a group's posts (`lookFor`); never in the extension's own work tabs.
  Besides that it only listens for the person's own clicks and Enter presses (`isTrusted`, never the page's), works out from the page
  around them whether one was a step and who to (`src/networks/facebook/actions.ts`), and tells the background. It never reads
  what was written, writes to the page, clicks, scrolls or sends anything, but for the next rules. What it does on its
  own keeps the owner's decisions: off by default, the daily limits, and a stop for the day on any Facebook warning.
- **Scrolling groups only when asked, slowly.** **Find posts** (`src/jobs/posts.ts`) only scrolls a group's own
  feed (`scrollFeed`, `groupFeedPage`), a screen at a time, 6 to 12 seconds apart: it opens nothing and presses
  nothing. Once a day, on its own, it also scrolls your friend requests and a group's members the same way
  (`scrollList`, `peopleListPage`, `src/jobs/people.ts`), 4 to 9 seconds apart, and your friends list and groups
  when asked (`scrollPage`, only on those pages). The look-up before drafting (`src/jobs/lookup.ts`) only opens and
  reads two pages in a window of its own, then closes it; none of these go on a day Facebook warned you.
- **Opening chats only when asked, slowly.** **Read my chats** (`src/jobs/chats.ts`) clicks the chat links in
  Messenger's own list and scrolls that list (`src/networks/facebook/browse.ts`), nothing else: never a button, never a box to
  type in. One chat every 7 to 14 seconds, at most 150 a run (60 once a day on its own), and it stops at once on a
  Facebook warning.
- **Pressing only on the download pages, only when asked.** `src/networks/facebook/fetch.ts` presses Facebook's buttons only
  on Accounts Center's download pages and the chats (`fetchPage`), only for an ask the person made in HandsFreeOS,
  and only what's in the box on top, never behind it. It never types: a password or PIN box on the page makes it
  wait for the person. Each step lists the words it may go by, the likeliest first, and one it can't find is handed
  to the person rather than guessed. `test/fetch.test.ts` walks a made-up Accounts Center, and again with bare boxes.
- **Pressing on profiles only for the people ticked.** Cancelling and unfriending (`src/networks/facebook/tidy.ts`) press only
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
  sending it with its button or Enter (`src/networks/facebook/auto.ts`). Its presses aren't the person's, so the content
  script doesn't notice them; the runner notes each one itself, marked `auto`. It sends a message only once
  HandsFreeOS says it's OK'd (`outreach.send.*`, `workLeft`): it drafts it with the AI after looking the person up in
  its own window, queues it, and sends what's OK'd in their chat in Messenger, or the chat window their profile's
  **Message** opens, typing only into that chat's box and leaving one with writing in it alone (`writeMessage`). When
  the person sends a few short texts (their voice, on to start), each part between blank lines goes as its own text, a
  few seconds apart, as long as typing it takes (`messageParts`, `partPauseMs`); once one has gone the message counts
  as sent, and its line says if a later one didn't. A message it couldn't send is reported as not sent, with why, and
  never tried again that day. Before a reply is drafted it opens their chat and brings its latest messages into
  HandsFreeOS (`bringInChat`, 0.33.0), since a reply seen in the list carries no words: the AI reads what they
  answered, and a yes comes back drafted as the next step, the video or the link, and is queued as that. A reply's
  draft says whether the AI found it simple, which with **Replies** (b) lets it go by itself; HandsFreeOS decides
  (`goesAsItIs`), and holds back any reply to someone who needs the person.
  `test/auto.test.ts` walks a made-up profile, post, chat and chat window.
- **A warning stops the day.** The extension keeps the day's warnings itself (`hfos.warned`), so the runner and the
  asks on Facebook refuse to start, or stop, even when HandsFreeOS can't be reached.
- **Asks one at a time on each network, from HandsFreeOS only.** Only the computer that works takes one, and only the
  person's own; each network's line takes its own (`platform`), and an ask and a step of the runner's never go at once
  on one network (`inTurn`, by network). Its line goes at most every 20 seconds, its end
  keeps its moment and command id, and a step handed over waits half an hour at most. The panel's only button for an
  ask is **Stop**, for the one under way; it never starts one, and Carry on and Skip are pressed in HandsFreeOS.
- **The panel shows progress and activity only** (decision 72). It lists nothing waiting for the person and answers
  none of it: no message to OK, chat so far, reply, step to do or friend request. It says how many things need them,
  with a link to Needs you in HandsFreeOS, and a pop-up opens it there. `test/panel.test.ts` holds this.
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
  names. `test/actions.test.ts` takes each step on the hand-written pages, and again with bare boxes around everything;
  `test/linkedin-actions.test.ts` does LinkedIn's both ways in one.
- **A step is noted once it went.** Where a page shows only a moment later whether a press sent anything (LinkedIn's
  Connect and its box, Enter in a LinkedIn box, the newer layout's reaction button and the comment box's own buttons),
  the kit says what to look at, and the tab looks then (`maybe` in `src/networks/kit.ts`).
- **The background worker holds the sign-in.** It keeps the Supabase session in the extension's own storage and
  makes every call to HandsFreeOS (`src/hfos/session.ts`); the panel asks it (`src/hfos/messages.ts`), and it
  answers only the extension's own pages. The offscreen page answers only the extension's messages meant for it.
  One holder means panels in two windows never refresh the sign-in at once.
- **Cut to fit before sending.** `src/hfos/saves.ts` builds each save from the read, cut to what the commands take
  (`packages/core/src/addons/outreach/limits.ts`, which has no zod so the extension stays small), and keeps a chat's save
  under the API's 256 KB limit by sending the newest messages that fit.
- **Each reader checks itself.** When a page should have something and the reader finds none, it says so and asks for
  the outline (`src/networks/facebook/page.ts`).
- **An outline never holds what a person wrote.** `test/outline.test.ts` checks that no name, message or id survives.
- **No remote code.** Everything ships in the bundle; the stores forbid downloading code.
- **No real pages in the repo.** The pages in `test/fixtures` are written by hand to look like Facebook's and
  LinkedIn's, with made-up people. A saved real page holds other people's names and messages, so tune the readers from
  outlines instead: `linkedin-feed-2026-10.html` and `linkedin-own-profile-2026-10.html` rebuild the owner's two
  outlines of 16 Oct 2026 element for element, with made-up words and links where the outline hid them (their own
  outlines come out as his did). HTML written by hand can't hold a link inside a link, as LinkedIn's pages do: a page
  writes the inner one as `<span data-as="a" href="…">`, made a link when the tests load it (`test/load.ts`).
  `test/linkedin-newer.test.ts` holds the readers and the steps on them.

## Where things are

| Path                                        | What it is                                                                                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/networks/`                             | A kit per network (`kit.ts`, `index.ts`), which are on (`on.ts`), LinkedIn's script kept in step (`scripts.ts`), the outline (`outline.ts`)                                                                              |
| `src/networks/facebook/`                    | Facebook's kit: one reader per kind of page, the steps, the addresses, its words, the outline, the download steps, the runner's and asks' (`work.ts`)                                                                    |
| `src/networks/linkedin/`                    | LinkedIn's kit: its readers, the steps you take there (`actions.ts`), who wrote back, its words, its warnings, its outline, and the asks' steps (`work.ts`)                                                              |
| `src/content.ts`                            | The script in each tab of a network that's on, by its kit: reads the page when asked, looks at the tab in front of you, and notices your steps                                                                           |
| `src/panel/`, `public/`                     | The side panel: `account.ts` signing in, `status.ts` Next up and Done today, `networks.ts` Allow on LinkedIn and its warning, `needs.ts` how many things need you in HandsFreeOS                                         |
| `src/asks/run.ts`                           | What you ask of it from HandsFreeOS: taking each ask, doing it with its job, handing steps to you, and how it ended                                                                                                      |
| `src/hfos/asks.ts`                          | The asks' side of HandsFreeOS: take, progress, end (waiting with no connection), reply and stop                                                                                                                          |
| `src/jobs/`                                 | The jobs that go page by page: the file and bringing it in, tidying, the look-up, friends, groups and members, Find posts, Read my chats, checks; LinkedIn's in `linkedin/`                                              |
| `src/offscreen.ts`, `public/offscreen.html` | The offscreen page that opens the zips in your downloads for Bring them in                                                                                                                                               |
| `src/hfos/looked.ts`                        | What the tab in front of you read as you went: warnings noted, chats and posts sent                                                                                                                                      |
| `src/auto/`                                 | On its own: what it does next and when (`plan.ts`), Facebook's runner (`run.ts`) and LinkedIn's (`linkedin.ts`), the once-a-day jobs (`daily.ts`), the lists first (`lists.ts`), and taking turns with asks (`turns.ts`) |
| `src/hfos/`                                 | HandsFreeOS: the sign-in and calls (background), the saves, the steps noted, Facebook's times, its zips in downloads                                                                                                     |
| `src/hfos/follow.ts`                        | Your settings from HandsFreeOS, and the live channel's news: loaded at sign-in and each step, and followed live                                                                                                          |
| `src/hfos/setup.ts`                         | The first run: telling HandsFreeOS it's signed in, and opening HandsFreeOS's setup for a first-timer                                                                                                                     |
| `src/hfos/live.ts`                          | What it tells HandsFreeOS: this computer, the beat, the feed of steps, Start my day and Stop for today, and which computer works                                                                                         |
| `src/hfos/waiting.ts`                       | What needs you: the number on the icon and Chrome's pop-ups, which open Needs you in HandsFreeOS (its address and words in `src/hfos/needs-you.ts`)                                                                      |
| `src/tab.ts`                                | The tab a job works in, in view or in a window of its own                                                                                                                                                                |
| `src/background.ts`                         | Opens the side panel, answers its asks, notes the steps the tabs tell it, follows your settings and your day, beats, and wakes the runner and the asks                                                                   |
| `scripts/build.mjs`                         | Bundles with esbuild and writes `manifest.json`, with the version from `package.json` and LinkedIn's site as optional                                                                                                    |
| `test/`                                     | The readers and steps on the hand-written pages, the addresses, the outline's hiding, the saves, the jobs and the asks                                                                                                   |

## Next

LinkedIn, part by part (HANDSFREEOS_SOCIAL_NETWORKS_IMPLEMENTATION_PLAN.md): its asks are in (0.40.0), what it does
on its own there (0.41.0), getting and bringing in its file (0.42.0), and growing, with the helpful post on your own
feed (0.43.0). Tidying on its own and joining groups (decisions 29 and 31; docs/outreach.md, the rest
of decisions 26 to 35); Social Outreach's onboarding is built, in HandsFreeOS (decisions 36 and 45). Safari on Mac
follows in Phase 2.
