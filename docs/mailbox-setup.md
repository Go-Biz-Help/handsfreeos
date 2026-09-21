# Connecting Outlook and Gmail: the short version

This gets both mailbox integrations working, in order, with nothing you can skip and nothing you can't. It is the quickstart for "Connected mailboxes: Outlook and Gmail" in `docs/operations.md`, which stays the full reference: Microsoft publisher verification, Google's security review, admin approval at client businesses, secret rotation and the long troubleshooting tables all live there.

Budget about 20 minutes for Outlook and 30 for Gmail.

## What you are actually setting up

A teammate clicks **Connect Outlook** or **Connect Gmail** in **Settings** → **Email**. The browser goes to the worker, on to Microsoft or Google to sign in and approve, and back to the worker, which seals the sign-in and stores it:

```
Settings → Email
  → https://hooks.handsfreeos.com/oauth/<provider>/start
  → Microsoft or Google signs the person in
  → https://hooks.handsfreeos.com/oauth/<provider>/callback
  → back to Settings → Email
```

So the whole job is: register an app at each provider, and give the worker its client ID and secret. Four values in total. They go on `handsfreeos-worker` and nowhere else — never in this repository, never on the API, never in GitHub or Vercel. The API refuses to start if it sees a name beginning `MICROSOFT_OAUTH_` or `GOOGLE_OAUTH_`.

| Value                           | Where it comes from                                                          |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `MICROSOFT_OAUTH_CLIENT_ID`     | Entra app → **Overview** → **Application (client) ID**                       |
| `MICROSOFT_OAUTH_CLIENT_SECRET` | Entra app → **Certificates & secrets** → the secret's **Value** (shown once) |
| `GOOGLE_OAUTH_CLIENT_ID`        | **Google Auth platform** → **Clients** → your client → **Client ID**         |
| `GOOGLE_OAUTH_CLIENT_SECRET`    | The same client's **Client secret** (shown in full once)                     |

Every address below is built from `WORKER_PUBLIC_URL`, already set to `https://hooks.handsfreeos.com` in `apps/worker/fly.toml`. If that address ever changes, both redirect URIs have to change with it.

## Locally there is nothing to set up

Leave all four unset. **Connect Outlook** then opens a stand-in sign-in page on the worker and the mailboxes live in memory, which is also what the tests use. `pnpm env:local` writes no mailbox values, so this stays true. Production refuses the stand-in.

```bash
pnpm --filter @hfos/worker test mailbox
```

## Before you start

Three things, each one a real cause of a failed sign-in later.

```bash
curl -s https://hooks.handsfreeos.com/healthz     # {"ok":true}
curl -sI https://handsfreeos.com/privacy          # HTTP/2 200 (same for / and /terms)
```

And in Vercel's **Production** environment, `NEXT_PUBLIC_WORKER_URL` must be `https://hooks.handsfreeos.com`. Without it the Connect buttons send the browser to `http://127.0.0.1:4100` and nothing works.

## Outlook

You need a work account in a Microsoft Entra tenant with at least the **Application Developer** role. A personal outlook.com account will not do — Microsoft no longer lets personal accounts register apps, and an app registered that way can never be publisher verified.

**1. Register the app.** At `https://entra.microsoft.com` → **Entra ID** → **App registrations** → **New registration**.

- **Name**: `HandsFreeOS` (people see this on the consent screen).
- **Supported account types**: **Any Entra ID Tenant + Personal Microsoft accounts**. The worker signs in through Microsoft's `common` endpoint, so anything narrower breaks every sign-in with `AADSTS50194`.
- Leave **Redirect URI** empty and click **Register**.

Copy **Application (client) ID** from the **Overview** page. That is `MICROSOFT_OAUTH_CLIENT_ID`.

**2. Add the redirect URI.** **Authentication** → **Add Redirect URI** → the **Web** tile (not **Single-page application**), and enter exactly:

```
https://hooks.handsfreeos.com/oauth/microsoft/callback
```

Lower case, no trailing slash. A mismatch stops the sign-in with `AADSTS50011`.

**3. Add the Graph permissions.** **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**, then tick `offline_access`, `Mail.Read`, `Mail.ReadWrite` and `Mail.Send`.

You should see five **Delegated** rows, counting the `User.Read` every new app starts with. That is exactly what the worker asks for in `apps/worker/src/mailbox/graph.ts`; add nothing else. A missing row blocks connections later, because a client admin's approval grants only what is listed here.

**4. Create the client secret.** **Certificates & secrets** → **Client secrets** → **New client secret**, longest expiry (**24 months**). Copy the **Value** column immediately, not the **Secret ID** — Microsoft shows it once. That is `MICROSOFT_OAUTH_CLIENT_SECRET`. Put its expiry in your calendar with a reminder three weeks ahead; when a secret lapses every Outlook mailbox stops syncing.

**5. Give the worker both values.**

```bash
fly secrets import --app handsfreeos-worker
```

Paste these two lines, then press Return and Control-D. Fly restarts the worker.

```text
MICROSOFT_OAUTH_CLIENT_ID=<Application (client) ID>
MICROSOFT_OAUTH_CLIENT_SECRET=<the secret Value>
```

```bash
fly secrets list --app handsfreeos-worker
```

You should see both names listed. Outlook is now live: there is no switch in the web app, so every workspace's owners and admins can connect straight away. Skip to "Check it works".

Nothing needs entering in Entra for Microsoft's change notifications. The worker asks Graph to call `/webhooks/graph/notifications` and `/webhooks/graph/lifecycle` on its own public address when a mailbox connects.

Two things you do **not** need to get Outlook working, but will want before client businesses use it, both in `docs/operations.md`: branding and publisher verification (until then the consent screen says **Unverified**), and admin approval, which many Microsoft 365 tenants require before an employee can grant mail access. Personal Outlook.com accounts need neither.

## Gmail

**1. Create the project and turn the API on.** At `https://console.cloud.google.com`, new project `HandsFreeOS`, then **APIs & Services** → **Library** → **Gmail API** → **Enable**. Do this before step 3 — until the API is on, the Gmail scopes are not offered in the picker. It is the only Google API HandsFreeOS uses.

Sign in with an account you will keep: Google sends its review email to the project's owners.

**2. Set up the Google Auth platform.** **Google Auth platform** → **Get started**. App name `HandsFreeOS`, your support email, **Audience**: **External**, a contact email, agree to the User Data Policy, **Create**.

**3. Add the two scopes.** **Data Access** → **Add or remove scopes**, tick both, **Update**, then **Save**:

```
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.send
```

These are the only two the worker asks for (`apps/worker/src/mailbox/gmail.ts`), and it refuses a connection unless both were granted. Do not add `gmail.modify` or `https://mail.google.com/` — they are restricted too and widen Google's review for nothing.

**4. Add yourself as a test user.** **Audience** → **Test users** → **Add users**, with the Gmail addresses that will test. While the app is in **Testing**, only these addresses can connect at all, there can be at most 100, and each sign-in lapses seven days after it is approved — so expect a "Reconnect your Gmail mailbox" email every week until Google approves the app.

**5. Create the OAuth client.** **Clients** → **Create client** → **Web application**, name `HandsFreeOS worker`, leave **Authorized JavaScript origins** empty, and under **Authorized redirect URIs** add exactly:

```
https://hooks.handsfreeos.com/oauth/google/callback
```

A mismatch stops the sign-in with `redirect_uri_mismatch`. On **Create**, copy both values before closing the window: the **Client ID** ending `.apps.googleusercontent.com`, and the **Client secret** starting `GOCSPX-`, which is shown in full only now.

This client is only for Gmail. Sign in with Google to HandsFreeOS itself uses a separate client in a separate project.

**6. Give the worker both values.**

```bash
fly secrets import --app handsfreeos-worker
```

```text
GOOGLE_OAUTH_CLIENT_ID=<Google client ID>
GOOGLE_OAUTH_CLIENT_SECRET=<Google client secret>
```

**7. Turn the button on.** This is the step people miss. The worker is ready, but **Connect Gmail** stays greyed out with the badge "Waiting on Google’s review" until the web app is built with the flag. In Vercel's **Production** environment set

```
NEXT_PUBLIC_GMAIL_ENABLED=true
```

in lower case — `True`, `1` and `yes` all leave Gmail off — and redeploy. The flag turns Gmail on for everyone, and only your test users can get past Google's sign-in, so do this while no clients are using HandsFreeOS.

Branding, Search Console domain verification, restricted-scope verification and the CASA assessment are all about Google letting the public in. None of them is needed for a test user, who gets through the "Google hasn’t verified this app" warning with **Continue** (or **Advanced**, then the link). They are in `docs/operations.md`.

## Check it works

1. **Customers** → **People** → **Add person**, with an email address you control somewhere else. Only mail with people in Customers is ever brought in — everything else is skipped and never stored.
2. **Settings** → **Email** → **Connect Outlook** (or **Connect Gmail**). Sign in and leave every box on the consent screen ticked.

   You should see "Connected. Email with customers comes in over the next few minutes." and a row with the badge **Connected**.

3. From the customer's address, email the connected mailbox.

   You should see it in the **Inbox** within a minute or two. Outlook pushes and is also checked every five minutes; Gmail is polled every two. A new mailbox's first sync looks back 30 days.

4. Reply from that conversation, choosing `From <account> (Outlook)` as the sender.

   You should see it arrive in the same thread, with a copy in the mailbox's **Sent Items**. The next check matches that copy, so it doesn't show twice.

5. Check the log.

   ```bash
   fly logs --app handsfreeos-worker
   ```

   You should see no `a mailbox did not connect`, `mailbox sync failed` or `no Outlook notifications for now`.

## When it doesn't work

| What you see                                                        | Fix                                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Connect opens `127.0.0.1` and hangs                                 | `NEXT_PUBLIC_WORKER_URL` is missing in Vercel. Set it and redeploy                                                 |
| "Outlook isn’t set up yet" / "Gmail isn’t set up yet"               | That provider's client ID or secret is missing on the worker                                                       |
| "This sign-in link has expired"                                     | The link is over ten minutes old or already used. Connect again                                                    |
| `AADSTS50011`                                                       | The Entra redirect URI doesn't match. It must be on the **Web** platform, exactly as above                         |
| `AADSTS50194`                                                       | The Entra app isn't multitenant. Fix **Supported account types**                                                   |
| `AADSTS90094`, `AADSTS90095`, `AADSTS65001`, or "Approval required" | The client's tenant needs an admin to approve. See "Business clients: admin approval"                              |
| `redirect_uri_mismatch`                                             | The Google client's redirect URI doesn't match                                                                     |
| Google blocks the sign-in                                           | The app is in Testing and that address isn't a test user                                                           |
| **Connect Gmail** greyed out                                        | `NEXT_PUBLIC_GMAIL_ENABLED=true` isn't in the Vercel build. Set it and redeploy                                    |
| "needs permission to read and send mail"                            | A box was unticked. Connect again, leaving all of them ticked                                                      |
| Every mailbox shows **Not syncing** with `invalid_client`           | The client secret expired or is wrong. Set a new one; mailboxes recover within ~30 minutes                         |
| One mailbox shows **Needs reconnecting**                            | Normal after a password change, a revoked app, or Gmail's seven-day Testing limit. The person clicks **Reconnect** |

If a sign-in fails with no `a mailbox did not connect` line in the log, Microsoft or Google itself refused it: check the redirect URI, the account type (Microsoft) or the test users (Google), then connect again. The stuck **Connecting** row clears itself after ten minutes.
