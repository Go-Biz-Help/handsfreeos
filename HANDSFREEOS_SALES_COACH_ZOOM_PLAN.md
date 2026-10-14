# AI Sales Coach, live on Zoom — the plan

**Status (2026-10-14): a proposal.** Nothing here is built, and the decisions below are proposed answers waiting
for Chris's OK. Once they're settled, this becomes the build plan and the table's heading changes to "Decisions".

AI Sales Coach (`salescoach`) is on the planned list: "Listens to live or recorded sales calls and gives reps
objection handling, talking points, coaching, and post-call feedback." This plan builds it as an add-on, with a
**HandsFreeOS Zoom app** as the first place it listens. While a rep is on a Zoom sales call, a panel inside Zoom
shows, as the customer talks:

- **What to say next**: the next step of the business's script, and the question worth asking now.
- **Objection handling**: when the customer says "it's too expensive" or "I need to talk to my wife", the
  business's own answer to that objection, shortened to what fits this call.
- **Talking points**: facts about the service, price or offer the customer just asked about, from the business's
  own knowledge base and price list (never made up).
- **How it's going**: who is talking more, questions asked, and script steps covered or still to cover.

After the call, the coach writes the notes, a summary and a follow-up email draft onto the customer's timeline,
adds the tasks the rep promised, and scores the call against the script.

## Why Zoom can do this now

Zoom's **Realtime Media Streams** (RTMS) are open to all developers since June 2025. An in-meeting Zoom App can
start one with `startRTMS()` from Zoom's Apps SDK, and its server then gets each person's audio and Zoom's live
transcript as the call goes. The app has to be **user-managed** (each rep signs in to their own Zoom), RTMS scopes
can't be optional, and RTMS **uses Zoom credits** on HandsFreeOS's developer account. Whether it works when the
host is on Zoom's free Basic plan or the web client isn't answered by Zoom's docs yet; round one checks.

Sources: developers.zoom.us/docs/rtms/meetings/, …/getting-started/, …/add-features/, and the RTMS changelog of
June 25, 2025.

## How it fits HandsFreeOS's rules

| Rule (CLAUDE.md, docs/addon-architecture.md)   | How this keeps it                                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Providers talk to the worker, never the API    | Zoom's sign-in callback, its webhooks and the RTMS sockets all land on the **worker**. Zoom's client secret and webhook secret live only in the worker's environment.                                                                                                                     |
| The web talks to Supabase Auth and the API     | The Zoom panel is a page of `apps/web`. It signs in with Supabase Auth and gets its cards from an **API stream**, never from the worker or the database.                                                                                                                                  |
| Every change is a command                      | The worker writes cards, notes and scores through `salescoach.*` commands, as the system acting for the add-on. The AI's tools go through the kernel like every add-on's.                                                                                                                 |
| Build on core's records                        | A coached call is a record of kind `coached_call`, tied to the customer with a relationship, so the timeline, tasks, files and search work on it unchanged. Playbooks (scripts, objections, talking points) are records too. Own tables (`addon_salescoach`) only for the live card feed. |
| Not yet: an add-on's own credentials, webhooks | Real Estate built business-wide connections, sign-ins and per-connection webhook addresses in core. Zoom needs two things they don't do yet, so **core builds them first** (round 0).                                                                                                     |
| Start one with the generator                   | `pnpm addon:new salescoach …`, under its planned id. It starts in `development`, offered to nobody, and staff hand it to test businesses in `beta`.                                                                                                                                       |
| The AI sees only what it may use               | Look-ups (a playbook, last call's notes) run on their own. Sending the follow-up email is risk 2: it waits for the rep's OK.                                                                                                                                                              |

## Round 0: what core builds first

1. **A person's own add-on connection.** Today an add-on connection belongs to the business. A Zoom sign-in
   belongs to one rep, like a mailbox or a calendar does. Add a `user_id` to `app.addon_connections` (null for the
   business's own), with row security so a rep sees only theirs and owners see who's connected.
2. **One Zoom webhook address for the whole app.** Zoom sends every event for every rep to the single address set
   in the Marketplace, not one per connection, so the per-connection `/webhooks/addon/<token>` route doesn't fit.
   Add `/webhooks/zoom` to the worker: Zoom's URL check (the `endpoint.url_validation` challenge), its signature
   check, then the delivery is kept once (provider `zoom`) and handed to the add-on whose connection holds that
   Zoom user. A business with the add-on off has its deliveries set aside, as for every add-on.
3. **A live stream from the API.** The panel needs cards within a second or two. The API opens a server-sent-events
   stream, checked by permission like any query, fed by the add-on's card table. Built once in core so the next
   live add-on (Live Sales Assist, Meeting Assistant) reuses it.
4. **Zoom's page headers.** Zoom only opens an app page that sends its required security headers and is on the
   app's allowed domains. `apps/web` sends them on the panel's route only.

## Round 1: the coach on Zoom

- **Playbooks.** Settings → Sales Coach: the script's steps, the objections and the business's answers, and talking
  points. A starter playbook is drafted by the AI from the business's services, prices and knowledge base, and the
  owner edits it. One playbook per kind of call (first call, estimate review, follow-up).
- **Connect Zoom.** Each rep signs in to their own Zoom once, from the panel or from the add-on's page.
- **The live call.** The rep opens HandsFreeOS in Zoom's Apps panel and presses Start coaching (or it starts on
  its own, a setting). The worker opens the RTMS stream, keeps each person's words apart, and feeds the latest
  minute to the fast model with the playbook and what HandsFreeOS knows about the customer (found by the
  participants' email, or picked by the rep). A card shows when the customer raises an objection, asks a question
  the knowledge base answers, or the script stalls. Aim: a card within 2 seconds of the customer finishing.
- **Only the rep sees it.** The customer sees Zoom's own "an app is using this meeting's content" notice, never the
  cards. The panel reminds the rep to say the call is being transcribed, where the law asks for it.
- **After the call.** Notes, a summary, the objections that came up and how they went, the follow-up email draft
  (sent from the rep's mailbox after their OK), and tasks, all on the customer's timeline. The transcript is kept
  with the call; the audio isn't kept.
- **Outside Zoom too.** The same panel opens at `/app/w/<business>/a/salescoach/live` in a browser tab, for a rep
  who'd rather keep it beside Zoom on a second screen.

## Round 2: coaching over time

Each call scored against its playbook; a rep's trends (talk time, objections won, steps skipped); a manager's view
of the team; and the playbook improving itself from what worked ("this answer to price closed 6 of 9").

## Round 3: other calls

The same live coaching on HandsFreeOS's own phone calls (Twilio already streams them to the worker for the AI
teammate), then Google Meet and Microsoft Teams.

## Round 4: the Zoom App Marketplace

Zoom reviews an app before anyone outside HandsFreeOS's own Zoom account can add it. Until then it runs for test
accounts only. The review needs the privacy policy, a test login and a demo video; it takes weeks.

## Proposed decisions (waiting for Chris)

| Question                          | Proposed answer                                                                                                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sales Coach and Live Sales Assist | **One add-on.** Live Sales Assist (`salesassist`) is the live half of the same thing; it comes off the vote list, its votes count for Sales Coach, and its id is never reused.                        |
| How it listens on Zoom            | **Zoom's own RTMS**, through the HandsFreeOS Zoom App. No bot joins the call. (The other way, a recording bot like Recall.ai, shows up as a participant and costs per hour.)                          |
| Whose words feed the AI           | **Each person's audio into Deepgram**, which the worker already uses live on calls. Zoom's own transcript is the fallback. Round one measures both and keeps the faster.                              |
| Who sees the coaching             | **Only the rep on the call**, and their manager after it.                                                                                                                                             |
| What's kept                       | **The transcript, notes and scores**, on the customer's timeline. **No audio.**                                                                                                                       |
| Where scripts come from           | **The business's own playbooks**, drafted by the AI from what HandsFreeOS knows about the business, then edited by the owner.                                                                         |
| What it costs a business          | **Usage from the wallet**, by the minute coached (Zoom credits, Deepgram and the AI). Billing for add-ons isn't built ("Not yet"), so staff hand it out free while it's in beta and usage is counted. |
| How far round one goes            | **Rounds 0 and 1, web and Zoom.** Phone screens later.                                                                                                                                                |

## What HandsFreeOS needs from outside

- A Zoom developer account under Go Biz Help, and a **user-managed General app** with a Zoom App surface (in
  meetings), RTMS turned on, the audio and transcript scopes, and the RTMS start and stop events.
- Zoom credits for RTMS on that account.
- New worker settings: Zoom's client id and secret, and its webhook secret token. `docs/operations.md` gets a
  "Zoom" section saying where each comes from, as it has for Twilio.
