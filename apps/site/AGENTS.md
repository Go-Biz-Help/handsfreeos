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
- **Pictures carry this site, not paragraphs.** The little product mock-ups in
  `src/components/visuals.tsx` are drawn in the app's own tokens, so they theme with the page, stay
  sharp, cost nothing to load and never show a real customer's data. Add one rather than another
  paragraph. Real screenshots of the phone app live in `public/screenshots/`.
- Never invent a customer, a review, a logo or a number. There are no customers yet, and a made-up
  testimonial is the fastest way to lose a real one.

Microsoft publisher verification can be done from here if the DNS route ever fails: drop the
`microsoft-identity-association.json` file into `public/.well-known/`.

## How it is set up to be found

Searched-for wording lives in the `<title>` and the meta description; the headline on the page stays
the human one. Keep it that way — a page that reads like a keyword list converts worse and ranks no
better.

- **One `<h1>` per page**, and it is the page's own opening heading (`<SectionHeading as="h1">`).
  Every heading below it is an `h2`.
- **Every page sets `alternates.canonical`.** `www` redirects to the bare domain at Vercel, so there
  is one address per page and one canonical pointing at it.
- **Titles stay under about 60 characters** including the ` · HandsFreeOS` suffix, descriptions under
  about 160. Longer than that and a search result cuts them off mid-sentence.
- **Structured data is in `src/components/json-ld.tsx`**: Organization and WebSite and
  SoftwareApplication on the home page, FAQPage on the home and pricing pages, built from the same
  `src/content` files the pages render. Never add an `aggregateRating` or a `review` until real ones
  exist — invented ones are a manual penalty, and a lie.
- **The share picture is drawn in `src/app/opengraph-image.tsx`** with the system font, so no build
  ever fails fetching a typeface. `twitter-image.tsx` re-exports it.
- **`robots.ts` allows everything, including the assistants that answer questions** (OAI-SearchBot,
  PerplexityBot, ClaudeBot and the rest). People now shop for software inside chatbots, and a page
  they cannot read is a page that is never cited.
- **There is deliberately no `llms.txt`.** Measurement across hundreds of millions of AI crawler
  visits found it essentially never fetched, and Google has said it does not support it. The crawlers
  read the HTML, which is why the pages are written in self-contained sections.
