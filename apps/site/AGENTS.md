# apps/site — the public website at handsfreeos.com

This is the marketing site, not the product. The product is `apps/web` at `app.handsfreeos.com`.
They are deployed as **two separate Vercel projects** so a copy change never rebuilds the app.

- **No environment variables, no database, no API.** Every page is static. If a page ever needs a
  secret or a fetch, stop and reconsider: that probably belongs in `apps/web`.
- **Company facts, addresses and prices live in `src/content/site.ts`**, not in the pages.
- **The design tokens are copied from `apps/web/src/app/globals.css`** so the site and the app look
  like one product. If the accent colour changes there, change it here.
- **Three pages exist because somebody reviews them**, and their wording is not decoration:
  - `/privacy#google` — the Limited Use paragraph Google's OAuth review reads.
  - `/privacy#messaging` — the opt-in paragraph the carriers and Twilio's A2P review read.
  - `/terms` and `/support` — Microsoft's publisher verification and Apple's support URL.
    `docs/operations.md` points reviewers at these; change one and check that guide still matches.
- **The footer must name the legal company** (`company.legalName`). Twilio checks for it.
- Never invent a customer, a review, a logo or a number. There are no customers yet, and a made-up
  testimonial is the fastest way to lose a real one.

Microsoft publisher verification can be done from here if the DNS route ever fails: drop the
`microsoft-identity-association.json` file into `public/.well-known/`.
