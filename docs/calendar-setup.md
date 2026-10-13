# Calendar setup: Google and Outlook

The short path to making the **Google** and **Outlook** buttons in **Settings** → **My calendar** work.
"The calendar: Google, Outlook and online booking" in `docs/operations.md` is the same ground with the
reasoning, Google's review process and every failure mode. This page is only the steps, in order.

What you are turning on: HandsFreeOS reads each person's busy times from their own calendar — times only,
never titles — so nobody books them over it, and writes their HandsFreeOS appointments back into that
calendar as events with no guests.

Two tracks, and they are very different sizes:

| Provider | What it needs                                                                               | How long                 |
| -------- | ------------------------------------------------------------------------------------------- | ------------------------ |
| Outlook  | One permission added to the Entra app you already have for Outlook mailboxes                | 10 minutes               |
| Google   | Its own Google Cloud project, consent screen, scopes and OAuth client, then two worker keys | About an hour, then wait |

Do Outlook first: it is one sitting, and Google reviews nothing.

---

## On your laptop: there is nothing to set up

Leave `MICROSOFT_OAUTH_CLIENT_ID` and `GOOGLE_CALENDAR_OAUTH_CLIENT_ID` out of `apps/worker/.env`.
`pnpm env:local` never writes them, so this is the default. The two buttons then open a stand-in sign-in page
on the worker, and no Google or Microsoft account is touched. The `worker started` line shows `calendars: "fake"`.

1. `pnpm dev`, sign in, open **Settings** → **My calendar**, click **Google** or **Outlook**.
2. On the stand-in page, leave the address as `owner@gmail.fake` and click **Allow**. You land back on
   **My calendar**, **Connected**.
3. Give that calendar a busy time and click **Sync now**:

   ```bash
   curl -H 'content-type: application/json' \
     -d '{"account":"owner@gmail.fake","start":"2026-10-06T15:00:00Z","end":"2026-10-06T16:00:00Z"}' \
     http://127.0.0.1:4100/test/calendars/busy
   ```

   It shows as **Busy** in **Calendar**, with no title. `curl 'http://127.0.0.1:4100/test/calendars/events?account=owner@gmail.fake'`
   shows what HandsFreeOS wrote back.

Everything below is for production.

---

## Before you start

- The worker answers: `curl -s https://hooks.handsfreeos.com/healthz` gives `{"ok":true}`.
- Vercel's Production environment has `NEXT_PUBLIC_WORKER_URL=https://hooks.handsfreeos.com`. Both buttons
  reach the worker through it.
- For Outlook: the Entra app from "Connected mailboxes: Outlook and Gmail", with `MICROSOFT_OAUTH_CLIENT_ID`
  and `MICROSOFT_OAUTH_CLIENT_SECRET` already on `handsfreeos-worker`.
- For Google: `handsfreeos.com` verified in Google Search Console by the account you will use, and the three
  public pages (`/`, `/privacy`, `/terms`) live.

**Where secrets go:** `handsfreeos-worker` and your password manager. Nowhere else. Not `handsfreeos-api`
(it refuses to start if it sees any name containing `_OAUTH_`), not Vercel, not GitHub, not any file in this
repository. Leave `CALENDAR_PROVIDER` and `CALENDAR_REFRESH_MS` unset in production.

### What the worker needs, and what it doesn't

Four values in all, and Outlook's two are already there from mailboxes:

| Secret on `handsfreeos-worker`        | For               |
| ------------------------------------- | ----------------- |
| `MICROSOFT_OAUTH_CLIENT_ID`           | Outlook calendars |
| `MICROSOFT_OAUTH_CLIENT_SECRET`       | Outlook calendars |
| `GOOGLE_CALENDAR_OAUTH_CLIENT_ID`     | Google Calendar   |
| `GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET` | Google Calendar   |

Nothing else. **A person's own access and refresh tokens are never a Fly secret**: they come from the sign-in,
are sealed with `WORKER_ENCRYPTION_KEY` into the connection's `token_enc`, and the worker renews and re-seals
them ahead of expiry. Neither provider uses an API key — an OAuth client and a per-person token is the whole
of it.

Which means two things are worth remembering:

- `WORKER_ENCRYPTION_KEY` must already be set (the worker won't start without it), and losing or changing it
  makes every calendar reconnect. Rotate it through `WORKER_ENCRYPTION_KEYS_PREVIOUS`, never by replacing it.
- The Microsoft secret is shared with Outlook mailboxes, so when it expires both stop at once.

---

## Outlook

The Entra app already exists. Add one delegated permission.

1. Open `https://entra.microsoft.com` and sign in with the work account.
2. **Entra ID** → **App registrations** → **HandsFreeOS** → **API permissions**.
3. **Add a permission** → **Microsoft Graph** → **Delegated permissions**.
4. Search for `Calendars.ReadWrite`, tick it, click **Add permissions**.

You should now see six **Delegated** rows: `User.Read`, `offline_access`, `Mail.Read`, `Mail.ReadWrite`,
`Mail.Send`, `Calendars.ReadWrite`.

That is all. **Admin consent required** says **No** for this one, so don't click **Grant admin consent**. The
redirect URI (`https://hooks.handsfreeos.com/oauth/microsoft/callback`) and the worker's two Microsoft values
stay exactly as they are, and connected mailboxes keep working.

One thing to know: a business whose admin approved HandsFreeOS before you added this permission approved mail
only. Their employees may be asked for approval again before they can connect a calendar. Send that admin
`https://login.microsoftonline.com/organizations/adminconsent?client_id=<MICROSOFT_OAUTH_CLIENT_ID>`.

### Where the two Microsoft values come from

`fly secrets list --app handsfreeos-worker` settles it: if `MICROSOFT_OAUTH_CLIENT_ID` and
`MICROSOFT_OAUTH_CLIENT_SECRET` are listed, there is nothing to look up. Otherwise, on the same app
registration:

- **Client ID** — **Overview** → **Application (client) ID**. Not a secret, copy it whenever.
- **Client secret** — **Certificates & secrets** → **Client secrets**. Microsoft shows the **Value** once,
  when it is made. If it isn't in the password manager it is gone: click **New client secret**, take the
  **Value** column (not **Secret ID**), and import it to the worker. An app holds two secrets at once, so add
  the new one and check a mailbox and a calendar still sync before deleting the old.

If the app registration doesn't exist at all, register it first — "Microsoft (Outlook and Microsoft 365)" in
`docs/operations.md`, which also covers the tenant, publisher verification and branding. Two choices there
decide whether calendars can work: **Supported account types** must be **Any Entra ID Tenant + Personal
Microsoft accounts** (anything narrower breaks every sign-in, or locks out personal Outlook.com accounts), and
the redirect URI goes on the **Web** platform, never single-page application.

Skip to [Check it works](#check-it-works).

---

## Google

Google Calendar gets **its own Google Cloud project**, separate from the Gmail one. Google reviews a
project's scopes together, and Gmail's `gmail.readonly` is restricted, so sharing a project would make the
calendar wait on Gmail's CASA security assessment. On its own it needs at most Google's lighter review, and
there is no lab to pay.

Check the project name in the top bar before every step. The Gmail project is `HandsFreeOS`; nothing here
belongs in it.

### 1. The project and the API

1. `https://console.cloud.google.com`, signed in with the account that owns the Gmail project.
2. Project picker → **New project** → name it `HandsFreeOS Calendar` → **Create**.
3. Select it in the project picker.
4. **APIs & Services** → **Library**, search `Google Calendar API`, open it, click **Enable**.

Enable the API before step 3 below — until it is on, the Calendar scopes don't appear in the scope picker.

### 2. The consent screen

1. **Google Auth platform** → **Branding** → **Get started**.
2. **App name** `HandsFreeOS`, **User support email** yours → **Next**.
3. **Audience**: **External** → **Next**. Contact email → **Next**. Agree to the User Data Policy →
   **Continue** → **Create**.
4. Back on **Branding**, fill in the rest:
   - **App logo**: `design/brand/handsfreeos-icon.png` from this repository
   - **Application home page**: `https://handsfreeos.com`
   - **Privacy policy**: `https://handsfreeos.com/privacy`
   - **Terms of service**: `https://handsfreeos.com/terms`
   - **Authorized domains**: add `handsfreeos.com` (that covers `hooks.handsfreeos.com`)
   - **Developer contact information**: your email
5. **Save**.

### 3. The scopes

**Google Auth platform** → **Data Access** → **Add or remove scopes**. Tick exactly these four, then
**Update**, then **Save**:

```
https://www.googleapis.com/auth/calendar.freebusy
https://www.googleapis.com/auth/calendar.events.owned
openid
https://www.googleapis.com/auth/userinfo.email
```

If one isn't in the list, paste it into **Manually add scopes**.

These are what the worker asks for (`apps/worker/src/calendar/google.ts`), and it refuses a connection unless
both Calendar scopes were granted. `calendar.freebusy` reads busy times; `calendar.events.owned` writes the
person's own HandsFreeOS appointments; `openid` and `email` only say which account signed in. **Do not** add
`.../auth/calendar` or `.../auth/calendar.events` — they reach far more than HandsFreeOS uses.

Note whether each Calendar scope landed under the sensitive or the non-sensitive heading. That decides how
much of [Publishing](#publishing-google-only) you need.

### 4. Test users

**Google Auth platform** → **Audience** → **Test users** → **Add users**. Add your own Google address and
anyone else who will test, then **Save**.

While the app is in **Testing**: at most 100 test users, only they can connect, and **each sign-in lapses
after seven days** — testers reconnect weekly until the app is published. There is no switch in the web app:
the **Google** button shows for everyone as soon as the worker has the two values.

### 5. The OAuth client

1. **Google Auth platform** → **Clients** → **Create client**.
2. **Application type**: **Web application**. **Name**: `HandsFreeOS calendar worker`.
3. Leave **Authorized JavaScript origins** empty.
4. **Authorized redirect URIs** → **Add URI** → exactly:

   ```
   https://hooks.handsfreeos.com/oauth/google/callback
   ```

   The same address as the Gmail client's, on purpose — the worker tells the two apart by the sign-in's
   state. Anything else gives `redirect_uri_mismatch`.

5. **Create**. Don't close the window until both values are in your password manager, under a new entry
   "Google Calendar client":
   - **Client ID** (ends `.apps.googleusercontent.com`) → `GOOGLE_CALENDAR_OAUTH_CLIENT_ID`
   - **Client secret** (starts `GOCSPX-`) → `GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET` — shown in full only now

Keep the two Google clients apart: `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` stay Gmail's.

### 6. Give the worker the two values

```bash
fly secrets import --app handsfreeos-worker
```

Paste these two lines, then press Return and Control-D. Fly restarts the worker.

```text
GOOGLE_CALENDAR_OAUTH_CLIENT_ID=<Google Calendar client ID>
GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET=<Google Calendar client secret>
```

Then clear the clipboard (`pbcopy < /dev/null`) and confirm:

```bash
fly secrets list --app handsfreeos-worker
```

You should see both names, alongside `MICROSOFT_OAUTH_CLIENT_ID` and `MICROSOFT_OAUTH_CLIENT_SECRET`. Fly
shows names only, never values.

---

## Check it works

`fly logs --app handsfreeos-worker` should show a `worker started` line with `"calendars":"real"`. That only
says the real providers are on — production always uses them. These steps check the values.

1. Sign in at `https://app.handsfreeos.com`, open a workspace, **Settings** → **My calendar**. You should see
   "Not connected yet" with a **Google** and an **Outlook** button.
2. Click **Google**. A HandsFreeOS page titled "Google Calendar isn't set up yet" means one of the two values
   is missing.
3. Sign in as a test user. Google warns the app is unverified — click **Continue**, or **Advanced** and then
   the link. Leave both calendar permissions ticked.
4. Add an event in Google Calendar for tomorrow at 10:00, then click **Sync now** in **My calendar**.
5. Open **Calendar** in the sidebar and go to tomorrow: a **Busy** block at 10:00, with no title.
6. Book a test appointment with yourself on it. It appears in Google Calendar within a minute, no guests,
   described "Added by HandsFreeOS. Changes made in this calendar aren't copied back."
7. Cancel it. The event leaves the calendar within a minute.
8. For Outlook: three dots next to the calendar → **Disconnect**, then click **Outlook** and sign in. Each
   person connects one calendar at a time.
9. `fly logs --app handsfreeos-worker --no-tail` should show no `a calendar did not connect`,
   `calendar refresh failed` or `calendar write-through failed`.

Busy times are read every 10 minutes after that, 60 days ahead, and at once on **Sync now**.

---

## Publishing (Google only)

Testing is fine for your own team. To let anyone connect, and to end the seven-day lapse, publish:

1. **Google Auth platform** → **Branding** → **Verify branding**, then **Publish branding** within seven days.
2. **Audience** → **Publish app** → confirm. **Publishing status** becomes **In production**.

If both Calendar scopes sit under the non-sensitive heading, **Verification Center** may say nothing more is
needed and you are done. If either is sensitive, submit for verification there as well — that needs a demo
video, a reason for each scope, and a privacy policy that covers calendar data (busy times only, never titles;
kept only to stop double-booking; Google's Limited Use requirements; never ads, never sold). Full checklist:
"Verification with Google" in `docs/operations.md`. Outlook, and Google for your test users, keep working
while you wait.

---

## Google Meet links

A calendar's **Online** place can be set to **Make a Google Meet link** (Settings → Calendars → Locations). Each
appointment there then gets its own Meet link, made when HandsFreeOS writes the event into the host's Google
Calendar (the event asks for `conferenceData` with the appointment's id as its request id, so a retry never makes a
second link). The worker saves the link on the appointment with `appointment.set_meeting_link`, and reminders, the
portal and everyone else's calendar event show it. It should need no new scope (`calendar.events.owned` covers conference data on the person’s own events); check it on the first real connection. It only happens when the host (or someone
on the appointment) has Google Calendar connected and the calendar adds appointments to people's calendars; a link
someone typed in is never replaced. Locally the stand-in makes `https://meet.google.com/fake-…` links.

## Zoom

**Settings** → **My calendar** → **Video meetings** → **Connect Zoom** links a person's own Zoom account. For
now it only connects; making Zoom meetings for appointments is the next step of
`HANDSFREEOS_MEETINGS_IMPLEMENTATION_PLAN.md`.

Locally there is nothing to set up: with `CALENDAR_PROVIDER=fake` (the default on a laptop) the button opens the
same stand-in sign-in page as the calendars, with `owner@zoom.fake` filled in.

For production:

1. In the Zoom App Marketplace (marketplace.zoom.us), **Develop** → **Build App** → **General App**, managed by
   each user (not the account admin).
2. **OAuth redirect URL** and the allow list: `https://hooks.handsfreeos.com/oauth/zoom/callback`.
3. **Scopes**: making meetings and reading the user (`meeting:write:meeting`, `meeting:update:meeting`,
   `meeting:delete:meeting`, `user:read:user`); for the steps after this one, `user:read:settings` and
   `cloud_recording:read:list_recording_files`. The connection refuses a sign-in that comes back without a
   `meeting:write…` and a `user:read…` scope.
4. Give the worker the two values, and nothing else:

   ```bash
   fly secrets set -a handsfreeos-worker ZOOM_OAUTH_CLIENT_ID=… ZOOM_OAUTH_CLIENT_SECRET=…
   ```

   Without them the button ends on "Zoom isn’t set up yet". The API refuses to start with them (any name with
   `_OAUTH_`), like every other provider key.

5. Until Zoom approves the app for the Marketplace, only accounts added as testers on the app can connect.

Check the exact screen names against Zoom's current Marketplace before relying on them; they move.

## If something goes wrong

| What you see                                                    | What it is                                              | Fix                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| "Google Calendar isn't set up yet" / "Outlook isn't set up yet" | The worker is missing that provider's ID or secret      | Set the two values on `handsfreeos-worker`                                        |
| `redirect_uri_mismatch`                                         | The Google client's redirect URI doesn't match          | Make it exactly `https://hooks.handsfreeos.com/oauth/google/callback`             |
| Google's `Error 401: invalid_client` at sign-in                 | Google doesn't recognise the client ID the worker sent  | See "invalid_client at sign-in" below. Not the secret — rotating it won't help    |
| `AADSTS50011`                                                   | The Entra redirect URI doesn't match                    | `https://hooks.handsfreeos.com/oauth/microsoft/callback`, on the **Web** platform |
| Google blocks the sign-in                                       | App is in Testing, that address isn't a test user       | Add it under **Audience** → **Test users**                                        |
| "This sign-in link has expired"                                 | More than ten minutes passed, or the link was used once | Start again from **My calendar**                                                  |
| "Some permissions were left unticked"                           | A box was unticked on the consent screen                | Connect again, allow everything                                                   |
| Badge says **Needs reconnecting**                               | Google or Microsoft stopped accepting the sign-in       | The person clicks **Reconnect**. Only they can — admins can only disconnect       |
| Badge says **Not syncing**                                      | Five checks in a row failed; the line shows the error   | `invalid_client` means an expired or wrong secret — rotate it on the worker       |

Two more worth knowing: Outlook calendars share the Microsoft client secret with Outlook mailboxes, so when it
expires both stop. And the sign-ins are sealed with `WORKER_ENCRYPTION_KEY` — lose it and every calendar has
to be reconnected.

### invalid_client at sign-in

`invalid_client` means two different things depending on when it arrives, and the two have different fixes.

**At a refresh**, in the worker's log or behind a **Not syncing** badge, it is the client secret: expired, wrong
or from the other Google client. Rotate it on the worker.

**At sign-in**, as Google's own `Error 401: invalid_client` page with `flowName=GeneralOAuthFlow`, the secret is
not involved at all — the authorize request carries only the client ID, the redirect URI, the scopes, the state
and the PKCE challenge (`apps/worker/src/calendar/google.ts`). Rotating the secret changes nothing. Two things
are already established by the fact that you got Google's page rather than the worker's "Google Calendar isn't
set up yet": both values are set on the worker (`startCalendar` refuses to redirect otherwise), and Google was
handed a client ID and rejected that ID.

The failing URL in the address bar is the evidence. Find `client_id=` in it — that is verbatim what the worker
sent — and check, in order:

1. It is a client ID at all. `%3C` and `%3E` are `<` and `>`, so a `client_id=%3C…%3E` means a placeholder
   from these instructions was imported as the value — the worker stored `<Google Calendar client ID>`, or
   `<id>`, and sent it. Google answers "The OAuth client was not found." Set the real value, **and the secret
   in the same import**: the secret is not sent here, so a placeholder in it stays invisible until the token
   exchange right after consent, where it fails as `invalid_client` all over again.
2. It ends in `.apps.googleusercontent.com`. If it starts `GOCSPX-`, the secret went into the ID.
3. Nothing is wrapped around it. `%22` at either end means quotes were stored as part of the value:
   `fly secrets import` takes everything after the `=`, so `KEY="…"` keeps the quotes. A trailing space or
   newline does the same.
4. It matches the **Clients** page of the `HandsFreeOS Calendar` project character for character.

If the ID is right, check the client still exists, the project isn't deleted, and the client's type is **Web
application**. A client made minutes ago may still be propagating; past ten, it is not that.
