# apps/site — the public website at handsfreeos.com

This is the marketing site, not the product. The product is `apps/web` at `app.handsfreeos.com`.
They are deployed as **two separate Vercel projects** so a copy change never rebuilds the app.

- **No database and no API of its own.** What it reads from outside is small and server-side: the founding
  counters (`WORKER_PUBLIC_URL`), the chat button (`NEXT_PUBLIC_CHAT_WIDGET_KEY`) and the blog
  (`OPINLY_API_KEY`, `OPINLY_WEBHOOK_SIGNING_SECRET`; see "The blog" below). Every page still renders
  without them. If a page needs a secret or a fetch beyond those, stop and reconsider: that probably
  belongs in `apps/web`.
- **Company facts, addresses and prices live in `src/content/site.ts`**, not in the pages.
- **The design tokens are copied from `apps/web/src/app/globals.css`** so the site and the app look
  like one product. If the accent colour changes there, change it here.
- **Three pages exist because somebody reviews them**, and their wording is not decoration:
  - `/privacy#google` — the Limited Use paragraph Google's OAuth review reads.
  - `/privacy#messaging` — the opt-in paragraph the carriers and Twilio's A2P review read.
  - `/terms` and `/support` — Microsoft's publisher verification and Apple's support URL.
    `docs/operations.md` points reviewers at these; change one and check that guide still matches.
- **The home page's `<title>` starts with `HandsFreeOS`**, unlike every other page. Google's OAuth
  review checks it against the consent screen's app name, and flagged a mismatch while the name
  came last.
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
  browser calls go through `lib/opinly/pixel.ts`. The founding form identifies the visitor and sends a
  `generate_lead` from the browser and from `api/founding/apply` (same `externalEventId`, an id the form makes per send, so
  they merge). The worker sends `sign_up`, `begin_checkout` and `purchase` (`apps/worker/src/opinly.ts` and
  `founding/checkout.ts`).
  `components/signup-link-visitor.tsx` adds the pixel's visitor id to every link to the app's sign-up as
  `?oa=`; the sign-up form keeps it on the account, and the worker sends it with those events, so they land on
  the exact visit. `/privacy` says all of this; change one and change the other.
