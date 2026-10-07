# Facebook Messenger and Instagram (20261025000200)

A business connects its Facebook Pages and the Instagram professional accounts linked to them in **Settings** →
**Facebook & Instagram**. Their messages then land in the inbox beside texts, email and the website chat, and the
team answers them from there, on the web and on the phone. When somebody comes from an ad or a link, the
conversation and the customer's page say which, and every time it happens is kept.

Setting up Meta's side (the app, its webhook, App Review and the worker's secrets) is "Facebook and Instagram
messages: Meta" in `docs/operations.md`.

## Where things are

| What                                      | Where                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Tables                                    | `supabase/migrations/20261025000200_facebook_and_instagram_messaging.sql`                                       |
| Rules and words both apps share           | `packages/core/src/messaging/social.ts`, `inbox/composer.ts` (`socialNote`), `inbox/thread.ts`                  |
| Commands                                  | `packages/core/src/commands/social.ts`; replies are `message.send` and `message.retry` in `commands/message.ts` |
| Reads                                     | `packages/core/src/queries/social.ts` (`meta_account.list`, `attribution.list`), `conversation.get`'s `social`  |
| Where somebody came from, in words        | `packages/core/src/crm/attribution-words.ts`                                                                    |
| Meta's Graph API, and the stand-in        | `apps/worker/src/social/graph.ts`, `fake.ts`                                                                    |
| Signing in and picking Pages              | `apps/worker/src/social/connect.ts`, through `apps/worker/src/http/oauth.ts`                                    |
| Webhooks, deauthorize and data deletion   | `apps/worker/src/social/routes.ts`; each event read by `events.ts`, and acted on by `receive.ts`                |
| Sending                                   | `apps/worker/src/social/send.ts`                                                                                |
| Ad look-ups and the daily check           | `apps/worker/src/social/jobs.ts`                                                                                |
| Settings → Facebook & Instagram           | `apps/web/src/components/settings/facebook-instagram-page.tsx`                                                  |
| The inbox, the composer and the thread    | `apps/web/src/components/inbox/` (`social-bits.tsx` has the two marks)                                          |
| "Where they came from"                    | `apps/web/src/components/crm/attribution-card.tsx`, `apps/mobile/src/components/customers/attribution.tsx`      |
| The phone's threads, replies and the mark | `apps/mobile/src/app/app/w/[workspaceId]/inbox/[conversationId].tsx`, `components/inbox/social-icons.tsx`       |

## How it works

**Connecting.** **Connect Facebook** runs `meta_connection.connect`, then sends the browser to the worker's
`/oauth/facebook/start`, which sends it on to Facebook's sign-in (Facebook Login for Business). Back at
`/oauth/facebook/callback`, the worker reads the Pages the person manages and the Instagram accounts linked to them.
With more than one, the person ticks which ones on the same finishing page the other sign-ins use. Each one ticked
is `meta_account.connect`, and the worker asks Meta to send that Page's messages here (`subscribed_apps`). First it
points the app's own webhook here, with every field it reads (`/{app-id}/subscriptions`): Meta sends a Page's events
only for the fields both the app and the Page ask for, and its dashboard doesn't list them all. The person's own
sign-in is kept as a `meta_connection`: it is what reads the ads.

**A message arrives.** Meta posts to `/webhooks/meta`. The worker checks Meta's signature with the app secret, keeps
each event as a `webhook_deliveries` row of its own (provider `meta`, keyed so a retry from Meta is kept once), and
answers 200 at once. The delivery loop then reads each event: the person (`meta_contacts`, asked of Meta once for
their name or @handle), their conversation (counterpart `messenger:<page id>:<their id>` or
`instagram:<account id>:<their id>`), and the message (`meta_message.receive`), with any photos, videos, recordings
and files copied off Meta into storage. A stranger who writes becomes a customer and a lead, unless the business
turned that off in **Settings** → **Lead intake** ("Someone messages your Facebook Page", and the same for Instagram).
When another app also answers the Page, such as HighLevel as its default app for messages, Meta sends the chats that
app holds as `standby` events, and only to apps that ask for them. The app's webhook and the Page's subscription both
ask, and they're read like any other message.

**Replying.** A reply is `message.send` with `channel: 'messenger'` or `'instagram'`, queued like a text. The worker
sends its photos and files first, each a message of its own, then the words, and keeps each part's id on the
message (`provider_part_ids`) the moment it goes. Meta's echo of a reply finds it by any of them, so it isn't kept
twice, and another try, the outbox's or a person's, sends only the parts that didn't go. A send Meta never answered
may have gone, so it isn't tried again by itself: the reply fails and says to check first. A reply written in
Facebook's or Instagram's own inbox comes back as an echo and is kept as the business's, marked "Sent from
Facebook", and the thread counts as answered. One within ten seconds of the customer's message is taken for the
Page's instant reply or away message, which Meta says back the same way: the thread still waits for a person.

**What else Meta sends.** Delivered and Seen; a customer's edit (the newest words are kept) and a message they take
back (its words and files go, as Meta asks); a button they tapped; and the ad or link they came from.

**When it stops working.** A Page whose sign-in expired or was changed is `meta_account.fail`: it shows "Needs
attention" in Settings, replies say why they can't go, and the owners get Automations' "Connection broke" once.
Connecting again (`meta_account.recover`) mends it in place, and its conversations keep their line. Removing the app
on Facebook (`/meta/deauthorize`) stops every sign-in of that person, in every business; asking Facebook to delete
their data (`/meta/data-deletion`) also forgets who they were. A sign-in nobody finished forgets its token as soon as
it ends, or at the daily look once its ten minutes are long gone. `meta.plan` runs daily and queues `meta.check` for
each business with a Page connected, which notices a sign-in that stopped working and asks Meta again for a Page's
messages when Meta stopped sending them.

## Rules worth knowing before changing anything

**Meta decides when a business may answer.** For a day after the customer last wrote, anybody may; with Meta's Human
Agent permission (`META_HUMAN_AGENT=on`, only once Meta approves it), a person may for seven. Never a workflow, the
AI teammate or HandsFreeOS itself after the first day. `socialReplyWindow` is the one copy of this rule: the
composer, `message.send`, `message.retry` and the worker all use it.

**The AI teammate doesn't answer these yet.** `message.send` refuses it (`social_people_only`),
`conversation.hand_to_ai` refuses these threads, and neither app offers to hand one over.

**A Page answers in one business at a time.** Meta sends a Page's messages to one place, so connecting it in a second
business is refused while the first still has it (`meta_accounts_live`). Disconnecting asks Meta to stop only once
nothing here answers through that Page any more.

**Tokens are sealed, and only the worker holds Meta's secrets.** Page tokens and sign-ins are sealed with
`WORKER_ENCRYPTION_KEY`. The API refuses to start with `FACEBOOK_APP_SECRET` or `META_WEBHOOK_VERIFY_TOKEN` in its
environment.

**Where somebody came from is never written over.** Each ad or link is a touch of its own (below). The customer's
`source` stays whatever first brought them.

**The phone keeps less.** Its sync streams send these conversations and messages (they are not portal threads), but
not who Meta says the person is, what they shared (a post, a reel, a story), edits or messages taken back: the
thread says to open the conversation on the web for those. "Where they came from" is asked of the API while there's
signal. Changing what the streams send recopies every phone (`apps/sync/README.md`), so it waits for a batch.

**Older phone builds.** A push names a Messenger or Instagram thread's channel in `refs.social`, not `refs.channel`:
builds before this drop a push whose `channel` they don't know.

## Where they came from: attribution

Meta says when somebody starts or comes back to a conversation from an ad, a link (`m.me/...?ref=`), the chat on a
website or Messenger's Discover tab: a `referral`, on its own or inside their first message. Each one becomes an
`attribution_touches` row:

- `kind`: `started` when it opened the conversation, `returned` when somebody already talking came back through it.
- `platform` and `channel`: where they saw it and where they answered.
- What Meta said, as it said it: `source`, `referral_type`, `ref`, `ad_id`, `ad_title`, `ad_photo_url`, `post_id`,
  `referer_uri`, and the whole referral in `raw`, so a field Meta adds later is already kept.
- Who and where: `person_id` (it follows the conversation when it's linked to a customer or merged, by trigger),
  `meta_account_id` and `meta_contact_id` (the Page and the person as Meta knows them), `conversation_id`,
  `message_id`, and `lead_id`, the lead open or opened when it came.

One visit is one touch, and a touch is never written over. Meta often reports a visit twice (the referral on its
own, then with the first message), so the same ad or link from the same person within ten minutes is the same touch;
Meta sending the same event twice keeps it once (`dedupe_key`).
The ad itself is an `ads` row, shared by every touch from it: `meta.resolve_ad` asks Meta's Marketing API for its
name, ad set, campaign and creative with a sign-in here that may read ads (`ads_read`). It says `no_access` when
nobody connected here can see that ad account, and asks again once somebody connects with ads allowed.

`attribution.list` returns a customer's or a conversation's touches, newest first, with the first one named. That is
the web's card and the phone's.

**What this is built for next**, without changing the tables:

- **First and last touch.** The earliest touch for a person, and the latest before the moment being credited.
- **Assisted.** Every touch between the first and that moment.
- **Opportunity credit.** Touches joined to a lead by `lead_id`, or by `person_id` with `touched_at` up to the
  lead's creation.
- **Revenue credit.** The same joined to the customer's invoices and payments, split by whichever model is chosen.
- **Conversions back to Meta.** Meta's Conversions API for business messaging takes a qualified lead, a booking or a
  purchase with the Page's id and the person's page-scoped id (Messenger), or the Instagram account's id and theirs
  (Instagram). Both are on the touch, through `meta_account_id` and `meta_contact_id`. It also needs a dataset tied
  to the Page and its own permission: check Meta's current documentation when building it.

## Not yet

- Messages from before a Page was connected. Meta's Conversations API can return them; today a conversation starts
  with the first message after connecting.
- The AI teammate answering on Messenger and Instagram.
- Sending conversions back to Meta (above).
- Reactions (Meta sends them; they are left), comments on posts, and story mentions as conversations of their own.
- The phone keeping the person's name from Meta, shared posts, edits and messages taken back (above).
