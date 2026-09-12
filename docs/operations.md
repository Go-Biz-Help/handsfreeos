# Running HandsFreeOS

Plain steps for the parts of HandsFreeOS that live outside the code: hosting, the phone carrier, and the keys
that go with them. Secrets never go in this repository; they live in Fly.io, GitHub and your password manager.

## Hosting: the API and the worker on Fly.io

The web app stays on Vercel. The API (`api.handsfreeos.com`) and the worker (`hooks.handsfreeos.com`) run on
Fly.io. The worker receives the phone carrier's webhooks, so it never sleeps.

### One-time setup

1. Create the organization and the two apps. If a name is taken, change `app =` in `apps/api/fly.toml` or
   `apps/worker/fly.toml` to match.

   ```bash
   fly apps create handsfreeos-api --org <your-org>
   fly apps create handsfreeos-worker --org <your-org>
   ```

2. Set the API's secret. The API refuses to start if it is given any provider key or Supabase secret key.

   ```bash
   fly secrets set --app handsfreeos-api DATABASE_URL='<connection string for the hfos_api role>'
   ```

3. Set the worker's secrets. Generate the encryption key once and save it in your password manager: the
   worker seals every client's phone-carrier credentials with it, and they can't be opened without it.

   ```bash
   fly secrets set --app handsfreeos-worker \
     DATABASE_URL_WORKER='<connection string for the hfos_worker role>' \
     SUPABASE_SECRET_KEY='<the hosted project secret key>' \
     SMTP_URL='<smtps:// address of the production mail provider>' \
     WORKER_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
     TWILIO_ACCOUNT_SID='<master account SID>' \
     TWILIO_AUTH_TOKEN='<master account auth token>'
   ```

4. Let GitHub deploy. Create a Fly token that can deploy both apps and store it as the repository secret
   `FLY_API_TOKEN`. Until that secret exists, the Deploy workflow only notes that it skipped.

   ```bash
   gh secret set FLY_API_TOKEN
   ```

5. Point the domains. Ask Fly for certificates, then add the DNS records it prints at your DNS provider.

   ```bash
   fly certs add api.handsfreeos.com --app handsfreeos-api
   fly certs add hooks.handsfreeos.com --app handsfreeos-worker
   ```

### Every deploy

A push to `main` runs CI; when CI passes, the Deploy workflow ships the worker first and then the API. You can
also run it by hand from GitHub: Actions, then Deploy, then Run workflow.

After a deploy, both of these should answer `{"ok":true}`:

- `https://api.handsfreeos.com/healthz`
- `https://hooks.handsfreeos.com/healthz`

To go back to the previous version, list releases with `fly releases --app <app>` and redeploy the image of
the one you want with `fly deploy --app <app> --image <image>`.

### Rotating the worker's encryption key

Set the new key as `WORKER_ENCRYPTION_KEY` and move the old one into `WORKER_ENCRYPTION_KEYS_PREVIOUS`
(comma-separated if there are several). The worker opens values sealed with any of them and seals new values
with the current one. Remove an old key only after every stored credential has been sealed again.

## The phone carrier: Twilio

- **Account.** Upgrade the Twilio account to paid. Its master account SID and auth token go into the worker's
  secrets above. HandsFreeOS creates one subaccount per client business and buys numbers inside it; there is
  nothing to set up per client in the Twilio console.
- **Webhooks.** The worker points each number at `https://hooks.handsfreeos.com` when it buys it. If that
  address ever changes, the numbers need re-pointing.
- **Toll-free numbers** can be registered for texting right away.
- **Local numbers** need HandsFreeOS's own business profile approved in Twilio's Trust Hub first (the
  "primary customer profile" for a software company that registers its clients). Once it is approved, add its
  `BU…` id to the worker as `TWILIO_PRIMARY_PROFILE_SID`. Until then, the app turns local-number registrations
  down with a message suggesting a toll-free number.
- **Costs** come per number each month, per text and minute, and per registration; they show on the Twilio
  bill of the master account.

### Calls

- **Nothing to set up per client.** When a business buys its number, the worker also creates what browser
  calls need in that business's subaccount: an API key (its secret is sealed with the worker's encryption key)
  and a "TwiML app" that places the calls teammates make from the browser.
- **Protect recordings.** In the Twilio console, under Voice settings, turn on "Enforce HTTP Auth on Media
  URLs". The worker always signs in to download a voicemail, copies it into Supabase Storage, and deletes
  Twilio's copy once the transcript arrives.
- **Transcripts** use Twilio's built-in voicemail transcription (English, messages up to two minutes). Twilio
  has marked that feature as deprecated; the assistant in Milestone 4 replaces it.
- **Try these with real phones before a client relies on calls:**
  1. Call the business number with one forwarding phone on. Every open browser and the forwarding phone
     should ring, and the forwarding phone should hear "Press 1 to take it" before it connects.
  2. Let the forwarding phone's own voicemail pick up. The call must keep ringing the browsers, then go to
     the business's voicemail, not the cell's. Twilio's documentation does not say whether the other phones
     stop ringing at that moment, so this needs checking.
  3. Call a customer from the browser. The customer should see the business number.
- **Microphones need HTTPS.** Browsers only allow calls from pages served over HTTPS (or localhost).

## Email: Postmark

Every business sends from its own address on `mail.handsfreeos.com` (like `lone-star@mail.handsfreeos.com`,
with the business name shown), and customers' replies come back to the same subdomain. A business can add its
own domain in Settings → Email; once its DNS records verify, it can send from that domain instead.

### One-time setup

1. Create a Postmark account and one server for production. Keep its default "outbound" (transactional)
   stream, and add an inbound stream.
2. In Postmark's Sender Signatures, add the domain `mail.handsfreeos.com` and put the DKIM TXT record and the
   Return-Path CNAME (`pm-bounces.mail.handsfreeos.com` pointing to `pm.mtasv.net`) it shows at your DNS
   provider. Do the same for `handsfreeos.com` if platform mail (invitations, alerts) moves to Postmark too.
3. Point `mail.handsfreeos.com`'s MX record at `inbound.postmarkapp.com` (priority 10), and set it as the
   inbound stream's inbound domain.
4. Make up a long random webhook password (keep it in your password manager). Set the inbound stream's
   webhook to `https://postmark:<password>@hooks.handsfreeos.com/webhooks/postmark/inbound`, and add an
   outbound webhook for Delivery, Bounce and Spam Complaint to
   `https://postmark:<password>@hooks.handsfreeos.com/webhooks/postmark/events`.
5. Give the worker its secrets. The account token lets it add businesses' own domains.

   ```bash
   fly secrets set --app handsfreeos-worker \
     POSTMARK_SERVER_TOKEN='<server API token>' \
     POSTMARK_ACCOUNT_TOKEN='<account API token>' \
     POSTMARK_WEBHOOK_PASSWORD='<the webhook password>'
   ```

6. Add a DMARC record for `mail.handsfreeos.com` that starts at `v=DMARC1; p=none; rua=mailto:<your address>`,
   and tighten it once reports look clean.

### Good to know

- **Stopped addresses are shared.** Postmark stops an address for the whole stream after a hard bounce or a
  spam complaint, so a bad address one business used is stopped for every business. HandsFreeOS also keeps
  each business's own list, shown in Settings → Email. If a business ever needs its own list, it can move to
  its own Postmark stream or server later.
- **Replies always route through `mail.handsfreeos.com`,** even for a business on its own domain, so a
  business never needs MX changes on its own domain.
- **Nothing is tracked.** Open and link tracking are off for customer email.
- **Gmail waits on Google.** Settings → Email shows Connect Gmail as waiting on Google's review until the web
  app is built with `NEXT_PUBLIC_GMAIL_ENABLED=true`. Turn it on once Google approves the restricted scopes.

## Local development

`pnpm dev` runs the web app, the API and the worker. Locally the worker uses a fake carrier: numbers, texts,
delivery receipts and carrier approvals all happen in memory, so nothing costs money and no phone is needed.
To try the real Twilio from a laptop, set `TELEPHONY_PROVIDER=twilio` and the Twilio keys in
`apps/worker/.env`, and give the worker a public address with a tunnel as `WORKER_PUBLIC_URL`.
