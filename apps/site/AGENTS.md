# apps/site — the public website at handsfreeos.com

This is the marketing site, not the product. The product is `apps/web` at `app.handsfreeos.com`.
They are deployed as **two separate Vercel projects** so a copy change never rebuilds the app.

- **No database and no API of its own.** What it reads from outside is small and server-side: the founding
  spot counters (`WORKER_PUBLIC_URL`), the chat button (`NEXT_PUBLIC_CHAT_WIDGET_KEY`) and the blog
  (`OPINLY_API_KEY`, `OPINLY_WEBHOOK_SIGNING_SECRET`; see "The blog" below). Every page still renders
  without them. If a page needs a secret or a fetch beyond those, stop and reconsider: that probably
  belongs in `apps/web`.
- **Company facts, addresses and prices live in `src/content/site.ts`**, not in the pages.
- **HandsFreeOS is sold as founding spots, first come, first served** (2026-10-27): $497 a year or $97 a
  month, each with its own live count. Nobody applies. Every sign-up button goes to the app's sign-up, which
  goes straight on to picking a spot and paying; a spot's own button adds `?plan=yearly` or `?plan=monthly`
  so that spot is picked to start with. Which spots are on sale and how many are left come from the database
  (`src/lib/founding.ts`), never from this repo. `/founding`, the old application page, redirects to
  `/pricing`.
- **`src/proxy.ts` is for affiliate links only** (`handsfreeos.com/?ref=<code>`, see `src/lib/affiliate.ts`):
  it keeps the code in a cookie for 90 days, tells the worker about the click, and sends the visitor on to
  the same page without `?ref=`. `SignupLinkVisitor` adds the code to sign-up links, as it does Opinly's id.
  A discount or trial code's link (`?code=<code>`) is kept the same way, with no click, and goes to sign-up
  as `?code=` for the plan page to fill in. Its matcher only lets through requests that have `?ref=` or
  `?code=`, so every other page is untouched.
- **`/affiliates` sells the affiliate program, and `/affiliates/terms` is what affiliates agree to.** The share
  and the most a code takes off are read live from the worker (`src/lib/affiliate-program.ts`), since staff change
  them; the page says "a share" without them. The terms page's date is the version affiliates agree to: change it
  with `AFFILIATE_TERMS_VERSION` in `packages/core/src/affiliates/terms.ts`, and every affiliate agrees again.
- **The design tokens are copied from `apps/web/src/app/globals.css`** so the site and the app look
  like one product. If the accent colour changes there, change it here.
- **Three pages exist because somebody reviews them**, and their wording is not decoration:
  - `/privacy#google` — the Limited Use paragraph Google's OAuth review reads.
  - `/privacy#messaging` — the opt-in paragraph the carriers and Twilio's A2P review read.
  - `/terms` and `/support` — Microsoft's publisher verification and Apple's support URL.
    `docs/operations.md` points reviewers at these; change one and check that guide still matches.
- **The home page's `<title>`, `<h1>` and share title all start with `HandsFreeOS`**, written
  exactly so, unlike every other page's title. Google's OAuth review checks them against the
  consent screen's app name, and flagged a mismatch while the name came last.
- **The footer must name the legal company** (`company.legalName`). Twilio checks for it.
- **The footer keeps the owner's tagline,** "The CRM that doesn't want you to use it.", on every page,
  since it stopped being the home page's headline.
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

## The blog

`/blog` is written in Opinly and read from its API (`https://sdk.opinly.ai/v1`) — posts arrive as Tiptap
JSON, not HTML. Everything that talks to Opinly is in `src/lib/opinly/`:

- **`client.ts` is `server-only`.** `OPINLY_API_KEY` is a secret (`sk-`) that can also record events and
  purchases in our name, so no client component may import it, and nothing it returns carries the key. The
  pixel's publishable `pk-` key in `components/opinly.tsx` is the only Opinly key a browser sees.
- **Every response is cached under the tag `opinly`**, for an hour at most. `/api/opinly-webhook` (Svix,
  `OPINLY_WEBHOOK_SIGNING_SECRET`) drops the tag with `revalidateTag('opinly', { expire: 0 })` and revalidates
  the changed paths the moment Opinly publishes. Both halves matter: paths alone do nothing for pages rendered
  per request. In svix 2, `verify()` only checks the signature — the handler parses the body itself.
- **`paths.ts` is the one map from Opinly's entities to our URLs**: posts flat at `/blog/<slug>`, then
  `/blog/category/<slug>`, `/blog/authors/<slug>` and `/blog/tag/<slug>`. The sitemap and the webhook both use
  it, and the folders under `src/app/blog` must match it.
- **Posts are prebuilt; lists render per request** from the cached answers, so a deploy never has to reach
  Opinly (CI builds with no key). Pictures come from Opinly's CDN, whose folder is allowed in `next.config.ts`.
- **A missing page is a real 404.** Each `[slug]` folder's `layout.tsx` checks the thing exists _before_ its
  `loading.tsx` starts streaming; a skeleton above that check turns every 404 into a 200 marked `noindex`.
- **`render.tsx` renders the body**: the title is the page's only `<h1>` (body headings shift down), links to
  our own pages lose Opinly's default `nofollow`, colour marks are dropped so text reads in dark mode, and
  unsafe link schemes are removed.
- **Analytics**: the pixel (`components/opinly.tsx`) loads on every page of the live site only, like Matomo;
  browser calls go through `lib/opinly/pixel.ts`. The worker sends `sign_up`, `begin_checkout` and `purchase`
  (`apps/worker/src/opinly.ts` and `founding/checkout.ts`).
  `components/signup-link-visitor.tsx` adds the pixel's visitor id to every link to the app's sign-up as
  `?oa=`; the sign-up form keeps it on the account, and the worker sends it with those events, so they land on
  the exact visit. `/privacy` says all of this; change one and change the other.

## Pages for comparing and for each trade

- **`/vs/<id>` puts HandsFreeOS beside a tool people already pay for** (Jobber, GoHighLevel), from
  `src/content/compare.ts`. Their side is only what their own pricing page says, linked and dated; ours is
  only what ships today; and each page says when the other tool is the better pick. Re-check their prices
  with `savings.ts`'s.
- **`/<slug>` is a page for one trade** (`/hvac`, `/plumbing`, `/lawn-care` …), from
  `src/content/trade-pages.ts`. Its example conversation and lost lead are the trade's own in `trades.ts`,
  and "Try it on your business" asks only for the name. Adding a trade means a `trades.ts` entry first.
- More of both can come later (the owner, 2026-10-30); the footer and the sitemap list them from those
  files, so a new entry needs no other change.

## Planned, not built yet

The owner's picks of 2026-10-30, to add to the site once each is ready:

- **A demo number the AI answers.** A real number on the home page that a visitor can text or call, and
  HandsFreeOS's own AI teammate answers and books a made-up job. It needs a number and the teammate set up
  on the HandsFreeOS business first.
- **A live "what it did today" ticker.** Anonymous counts from the real product, such as texts answered
  today. Only once there are customers: until then any count would be invented.
