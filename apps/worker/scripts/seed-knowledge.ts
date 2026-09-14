/**
 * Milestone 6 demo data, part one: Lone Star's knowledge base, built the way Dale would, through the commands.
 * - A filled-in business profile (what they do, services, service area, hours, policies, tone of voice), with
 *   "AI may quote prices" left off.
 * - Thirteen published FAQs and facts about heating, cooling and roofs, and one draft.
 * - A document: the maintenance plan's terms, uploaded as a text file. The worker reads it into a draft item,
 *   which Dale publishes.
 * - Dale asks Try it "Do you offer financing?". Nothing in the knowledge base answers it, so it becomes a gap
 *   suggestion; a customer's text asks the same later (seed-workflows) and joins it.
 * - A scan of the website, https://www.lonestarhvac.test: a stand-in served on this machine for the seed's own
 *   fetch while it scans (the address never leaves the seed). The worker's real scan job reads its pages and
 *   the stand-in model proposes facts and FAQs, which wait in Suggestions; what the knowledge base already
 *   has is left out.
 *
 * Also `seedAi()`: the scripted stand-in model with the seed's own rules first (seed-workflows uses it too), so
 * the AI-sorted reply and the AI-written answer read like the real thing. Texts stay in plain characters
 * (straight apostrophes, no dashes), so each counts as few texts as it can.
 */
import { createServer } from 'node:http';
import type { ScriptedProvider, ScriptRule } from '@hfos/ai';
import {
  executeCommand,
  fileConfirm,
  knowledgeDocumentAdd,
  knowledgeDocumentBeginUpload,
  knowledgeItemCreate,
  knowledgeItemPublish,
  knowledgeProfileUpdate,
  knowledgeScanStart,
  knowledgeSourceSet,
  type CommandDef,
  type HumanActor,
  type RequestMeta,
} from '@hfos/core/server';
import { rows, sql, type Db } from '@hfos/db/client';
import type { TestUser } from '@hfos/db/testing';
import type { z } from 'zod';
import { quotedBlock, scriptedAi, unquote } from '../src/ai/scripted';
import { createSafeFetch, type SafeFetch } from '../src/http/safe-fetch';
import { tryKnowledge } from '../src/knowledge/try';
import type { OutboxDeps } from '../src/outbox';
import { settle } from './seed-messaging';

export interface SeedKnowledgeDeps {
  readonly api: Db;
  readonly admin: Db;
  /** The worker's services with the seed's stand-in model (`seedAi()`). */
  readonly worker: OutboxDeps;
  readonly actor: (u: TestUser) => HumanActor;
  readonly meta: () => RequestMeta;
  readonly step: (msg: string) => void;
  /** Only work created after this is claimed (other suites leave rows behind). */
  readonly since: string;
}

export interface SeedKnowledgeWorkspace {
  readonly id: string;
  readonly organizationId: string;
  readonly dale: TestUser;
}

export interface SeededKnowledge {
  readonly published: number;
  readonly drafts: number;
  readonly suggestions: number;
  readonly seconds: number;
}

/** Lone Star's website address (a stand-in: see the header). */
export const LONE_STAR_WEBSITE = 'https://www.lonestarhvac.test';

// ---- The seed's stand-in model ----

const CUSTOMER_FIRST_NAME = 'Customer’s first name: ';

function firstNameIn(message: string): string {
  for (const line of (quotedBlock(message, 'run_details') ?? '').split('\n'))
    if (line.startsWith(CUSTOMER_FIRST_NAME))
      return unquote(line.slice(CUSTOMER_FIRST_NAME.length)).trim() || 'there';
  return 'there';
}

const customerSaid = (message: string): string =>
  unquote(quotedBlock(message, 'customer_message') ?? '').trim();

interface ContextItem {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

/** The knowledge items the context offers, best match first (FAQs arrive as "Q: …" and "A: …"). */
function contextItems(context: string): ContextItem[] {
  return [...context.matchAll(/<item id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/item>/g)].map((m) => {
    const [head = '', ...rest] = unquote(m[2]!).split('\n');
    const faq = head.startsWith('Q: ');
    const body = rest.join(' ').replace(/^A: /, '').trim();
    return { id: unquote(m[1]!), title: faq ? head.slice(3) : head, body };
  });
}

const sentencesOf = (text: string): string[] =>
  (text.match(/[^.!?]+[.!?]+/g) ?? [text]).map((s) => s.trim()).filter(Boolean);

/**
 * An answer to a customer's question, written from the best knowledge item (the repair-or-replace FAQ when it
 * is offered), with a promise to follow up on anything the knowledge doesn't cover (financing, here), which
 * also marks the question unanswered so it becomes a gap. At most 300 plain characters: two texts.
 */
function seedWrite(message: string, context: string) {
  const said = customerSaid(message);
  const items = contextItems(context);
  const best =
    items.find((i) => /repair or replace/i.test(i.title)) ??
    items.find((i) => /estimate/i.test(i.body)) ??
    items[0];
  const financing =
    /financ/i.test(said) && !items.some((i) => /financ/i.test(`${i.title} ${i.body}`));
  const close = financing
    ? 'Someone from our office will follow up about financing.'
    : 'Someone from our office will follow up shortly.';
  let text = `Hi ${firstNameIn(message)}, thanks for asking!`;
  for (const sentence of best ? sentencesOf(best.body) : [])
    if (`${text} ${sentence} ${close}`.length <= 300) text += ` ${sentence}`;
  return {
    message: `${text} ${close}`,
    usedItemIds: best ? [best.id] : [],
    unanswered: financing,
  };
}

/** An AI-sorted branch: something urgent, then wanting a visit, then a question, else the last path. */
function seedPath(message: string) {
  const said = customerSaid(message).toLowerCase();
  const paths = [
    ...(quotedBlock(message, 'paths') ?? '').matchAll(/<path id="([^"]+)">([^\n]*)<\/path>/g),
  ].map((m) => ({
    id: unquote(m[1]!),
    name: unquote(m[2]!).split(':')[0]!.trim().toLowerCase(),
  }));
  const named = (name: string) => paths.find((p) => p.name === name)?.id;
  const [hit, reason] = /\b(no (heat|cooling|air)|not cooling|leak|gas|smell|emergency|flood)/.test(
    said,
  )
    ? [named('emergency'), 'They describe something urgent.']
    : /\b(book|schedule|appointment|someone|come (out|by|look)|visit|this week|tomorrow)\b/.test(
          said,
        )
      ? [named('book'), 'They want someone to come out.']
      : said.includes('?')
        ? [named('question'), 'They ask a question.']
        : [undefined, ''];
  return {
    branchId: hit ?? paths.at(-1)?.id ?? '',
    reason: hit ? reason : 'Nothing else fits, so the last path.',
    usedItemIds: [],
  };
}

/** The seed's rules, ahead of the stand-in model's own (apps/worker/src/ai/scripted.ts). */
export const SEED_AI_RULES: readonly ScriptRule[] = [
  {
    // Try it: nothing in the knowledge base mentions financing.
    when: /financ[\s\S]*Answer the customer’s message above\.$/i,
    json: () => ({
      answer: 'Someone from Lone Star HVAC & Roofing will follow up with you about that soon.',
      usedItemIds: [],
      unanswered: true,
    }),
  },
  { when: /Pick the path above that fits best\.$/, json: (message) => seedPath(message) },
  {
    when: /Write the text message the instructions above describe\.$/,
    json: (message, context) => seedWrite(message, context),
  },
];

export function seedAi(): ScriptedProvider {
  return scriptedAi(SEED_AI_RULES);
}

// ---- What Dale writes ----

const PROFILE = {
  description:
    'Lone Star HVAC & Roofing repairs, replaces and maintains heating, air conditioning and roofs for homes and small businesses around Houston. Family owned since 2009.',
  services: [
    {
      name: 'AC repair',
      description: 'Same or next day for most calls, every major brand.',
      price: '$89 diagnostic, waived with the repair',
    },
    {
      name: 'AC and heat pump replacement',
      description: 'High-efficiency systems, with a free in-home estimate.',
      price: 'From $6,500 installed',
    },
    {
      name: 'Furnace repair and tune-ups',
      description: 'Gas and electric furnaces and heat pumps.',
      price: null,
    },
    {
      name: 'Maintenance plan',
      description: 'Two tune-ups a year, priority scheduling and 15% off repairs.',
      price: '$189 a year',
    },
    {
      name: 'Duct cleaning',
      description: 'Supply and return ducts with a truck-mounted vacuum.',
      price: null,
    },
    {
      name: 'Roof repair and inspection',
      description: 'Leaks, storm and hail damage; we meet your insurance adjuster.',
      price: null,
    },
    {
      name: 'Roof replacement',
      description: 'Shingle and metal roofs, with a free estimate.',
      price: null,
    },
  ],
  serviceArea:
    'Houston and nearby: Katy, Sugar Land, Pearland, The Woodlands, Cypress and Spring, about 40 miles around downtown.',
  hours:
    'Monday to Friday 7 AM to 6 PM, Saturday 8 AM to noon. Emergency heating and cooling calls 24/7.',
  policies:
    'Estimates for new systems and roofs are free. Diagnostic visits are $89, waived when you go ahead with the repair. Cancel or reschedule at least 24 hours ahead. Repairs carry a 1-year labor warranty; new systems carry a 10-year parts warranty when registered.',
  tone: 'Friendly, plain-spoken and quick. Short sentences, no jargon.',
  wordsToUse: ['tune-up', 'estimate', 'technician'],
  wordsToAvoid: ['cheap', 'guarantee'],
  signature: 'Lone Star HVAC & Roofing',
  allowPrices: false,
};

type Item =
  | { kind: 'faq'; question: string; answer: string; tags: string[] }
  | { kind: 'fact'; title: string; body: string; tags: string[] };

const faq = (question: string, answer: string, tags: string[]): Item => ({
  kind: 'faq',
  question,
  answer,
  tags,
});
const fact = (title: string, body: string, tags: string[]): Item => ({
  kind: 'fact',
  title,
  body,
  tags,
});

const PUBLISHED: readonly Item[] = [
  faq(
    'Do you service all brands?',
    'Yes. Our technicians repair and maintain every major brand of air conditioner, heat pump and furnace, including Carrier, Trane, Lennox, Goodman and Rheem.',
    ['hvac'],
  ),
  faq(
    'How soon can a technician come out?',
    'Most repair calls are seen the same or next business day. No cooling or no heat in extreme weather goes to the front of the line.',
    ['hvac', 'scheduling'],
  ),
  faq(
    'Do you offer emergency service?',
    'Yes. Emergency heating and air conditioning calls are answered 24/7, and after-hours visits have an extra trip charge.',
    ['hvac', 'emergency'],
  ),
  faq(
    'How often should my AC be serviced?',
    'Twice a year: the air conditioning in spring and the furnace or heat pump in fall. Our maintenance plan covers both visits.',
    ['hvac', 'maintenance'],
  ),
  faq(
    "What's included in a tune-up?",
    'We clean the coils, check the refrigerant and electrical parts, test the thermostat, replace a standard filter and clear the drain line.',
    ['hvac', 'maintenance'],
  ),
  faq(
    'Should I repair or replace my AC?',
    'If your system is over 12 years old or needs a major repair, replacing it usually costs less over time. We give free in-home estimates for new systems.',
    ['hvac', 'replacement'],
  ),
  faq(
    'Do you install heat pumps?',
    'Yes. We install and service heat pumps and can tell you whether one suits your home at a free in-home estimate.',
    ['hvac', 'replacement'],
  ),
  faq(
    'Do you work with insurance on storm damage?',
    'Yes. After storm or hail damage we inspect the roof, document it with photos and meet your insurance adjuster.',
    ['roofing', 'insurance'],
  ),
  faq(
    'How long does a roof replacement take?',
    'Most homes take one or two days, weather permitting. We protect the yard and haul everything away.',
    ['roofing'],
  ),
  faq(
    'Are your technicians licensed and insured?',
    'Yes. Our HVAC technicians are licensed by the Texas Department of Licensing and Regulation, and we carry full liability insurance.',
    ['company'],
  ),
  fact(
    'Service area',
    'Houston and nearby: Katy, Sugar Land, Pearland, The Woodlands, Cypress and Spring.',
    ['company'],
  ),
  fact(
    'Warranty on repairs',
    'Repairs carry a 1-year labor warranty. New systems carry a 10-year parts warranty when they are registered.',
    ['policies'],
  ),
  fact(
    'Payment',
    'We take all major cards, checks and cash. Payment is due when the work is done.',
    ['policies'],
  ),
];

const DRAFT: Item = faq(
  'Do you clean dryer vents?',
  "Not yet. We're looking at adding dryer vent cleaning next spring.",
  ['services'],
);

const MAINTENANCE_TERMS = `Lone Star HVAC & Roofing maintenance plan

What it covers
- Two tune-ups a year: the air conditioning in spring and the furnace or heat pump in fall.
- Priority scheduling: plan members are seen first when it's busy.
- 15% off repair parts and labor.
- No trip charge on repair visits during business hours.

How it works
The plan runs for 12 months from the first visit and renews each year. Cancel any time before it renews. Our office books each tune-up a few weeks before the season starts.
`;

// ---- The stand-in website ----

const page = (title: string, main: string) => `<!doctype html>
<html lang="en">
  <head><title>${title}</title></head>
  <body>
    <header><nav><a href="/">Home</a> <a href="/services">Services</a> <a href="/faq">FAQ</a></nav></header>
    <main>
${main}
    </main>
    <footer><p>Lone Star HVAC &amp; Roofing, 4410 Westpark Dr, Houston, TX 77027</p></footer>
  </body>
</html>
`;

/** Three pages and robots.txt; the sitemap names the real address, as a live site's would. */
const SITE: Readonly<Record<string, { type: string; body: string }>> = {
  '/robots.txt': {
    type: 'text/plain',
    body: `User-agent: *\nAllow: /\n\nSitemap: ${LONE_STAR_WEBSITE}/sitemap.xml\n`,
  },
  '/sitemap.xml': {
    type: 'application/xml',
    body: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${LONE_STAR_WEBSITE}/</loc></url>
  <url><loc>${LONE_STAR_WEBSITE}/services</loc></url>
  <url><loc>${LONE_STAR_WEBSITE}/faq</loc></url>
</urlset>
`,
  },
  '/': {
    type: 'text/html; charset=utf-8',
    body: page(
      'Lone Star HVAC &amp; Roofing | Heating, air and roofs in Houston',
      `      <h1>Lone Star HVAC &amp; Roofing</h1>
      <h2>Office hours</h2>
      <p>Monday to Friday 7 AM to 6 PM and Saturday 8 AM to noon. Emergency heating and cooling calls are answered 24/7.</p>
      <h2>Why homeowners call us</h2>
      <ul>
        <li>Upfront prices before any work starts</li>
        <li>Technicians who clean up after themselves</li>
        <li>A 1-year labor warranty on every repair</li>
      </ul>`,
    ),
  },
  '/services': {
    type: 'text/html; charset=utf-8',
    body: page(
      'Services | Lone Star HVAC &amp; Roofing',
      `      <h1>Services</h1>
      <h2>Attic insulation</h2>
      <p>We add blown-in insulation to attics so your air conditioning runs less in summer. Most homes take half a day.</p>
      <h2>Smart thermostats</h2>
      <p>We install and set up Wi-Fi thermostats from Ecobee, Honeywell and Google Nest.</p>
      <h2>Do you service all brands?</h2>
      <p>Yes, every major brand of air conditioner, heat pump and furnace.</p>`,
    ),
  },
  '/faq': {
    type: 'text/html; charset=utf-8',
    body: page(
      'FAQ | Lone Star HVAC &amp; Roofing',
      `      <h1>Frequently asked questions</h1>
      <h2>Do you offer free estimates?</h2>
      <p>Yes. Estimates for new heating and cooling systems and for roofs are always free.</p>
      <h2>How often should my AC be serviced?</h2>
      <p>Twice a year, in spring and fall.</p>`,
    ),
  },
};

async function standInSite(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!.replace(/(.)\/+$/, '$1');
    const found = SITE[path];
    res.writeHead(found ? 200 : 404, { 'content-type': found?.type ?? 'text/plain' });
    res.end(found?.body ?? 'Not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return {
    origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * The safe fetch, with Lone Star's address answered by the stand-in: each request goes to it (over plain http
 * on this machine, which the safe fetch allows for this one origin only), and where it ended up reads as the
 * real address again. Everything else keeps the usual rules.
 */
function standInFetch(origin: string): SafeFetch {
  const safe = createSafeFetch({ testOrigins: [origin] });
  return async (url, init) => {
    if (!url.startsWith(LONE_STAR_WEBSITE)) return safe(url, init);
    const res = await safe(`${origin}${url.slice(LONE_STAR_WEBSITE.length)}`, init);
    return {
      ...res,
      finalUrl: res.finalUrl.startsWith(origin)
        ? `${LONE_STAR_WEBSITE}${res.finalUrl.slice(origin.length)}`
        : res.finalUrl,
    };
  };
}

// ---- The seed ----

export async function seedKnowledge(
  d: SeedKnowledgeDeps,
  ws: SeedKnowledgeWorkspace,
): Promise<SeededKnowledge> {
  const started = Date.now();
  const workspaceId = ws.id;
  const dale = <I extends z.ZodType, O extends z.ZodType>(
    command: CommandDef<I, O>,
    input: z.input<I>,
  ) => executeCommand(d.api, command, input, d.actor(ws.dale), d.meta()).then((r) => r.output);

  d.step(
    'Lone Star: the knowledge base profile (services, area, hours, policies, tone; prices off)',
  );
  await dale(knowledgeProfileUpdate, { workspaceId, profile: PROFILE });

  d.step(
    'Lone Star: thirteen published FAQs and facts about heating, cooling and roofs, and a draft',
  );
  for (const content of PUBLISHED)
    await dale(knowledgeItemCreate, { workspaceId, content, status: 'published' as const });
  await dale(knowledgeItemCreate, { workspaceId, content: DRAFT, status: 'draft' as const });

  d.step('Lone Star: the maintenance plan terms uploaded; the worker reads the file into an item');
  const terms = Buffer.from(MAINTENANCE_TERMS, 'utf8');
  const upload = await dale(knowledgeDocumentBeginUpload, {
    workspaceId,
    name: 'Maintenance plan terms.txt',
    mimeType: 'text/plain' as const,
    sizeBytes: terms.length,
  });
  await d.worker.store.upload(upload.bucket, upload.objectPath, terms, 'text/plain', {
    upsert: true,
  });
  await dale(fileConfirm, { workspaceId, fileId: upload.fileId });
  await dale(knowledgeDocumentAdd, {
    workspaceId,
    fileId: upload.fileId,
    title: 'Maintenance plan terms',
  });
  const documentItem = async () =>
    (
      await rows<{ id: string }>(
        d.admin,
        sql`select id from app.knowledge_items where file_id = ${upload.fileId} and status = 'draft'`,
      )
    )[0]?.id;
  await settle(d, async () => (await documentItem()) !== undefined);
  await dale(knowledgeItemPublish, { workspaceId, itemId: (await documentItem())! });

  d.step(
    'Lone Star: Dale asks Try it "Do you offer financing?"; nothing answers it, so it waits as a gap',
  );
  const tried = await tryKnowledge(
    { ...d.worker, httpDb: d.worker.db, verifyToken: null, webOrigins: [] },
    d.actor(ws.dale),
    { workspaceId, question: 'Do you offer financing?' },
  );
  if (!tried.gap) throw new Error('Try it should have turned the financing question into a gap.');

  d.step(
    `Lone Star: its website (${LONE_STAR_WEBSITE}, a stand-in here) scanned; suggestions wait for Dale`,
  );
  const site = await standInSite();
  try {
    await dale(knowledgeSourceSet, { workspaceId, url: LONE_STAR_WEBSITE });
    const { scanId } = await dale(knowledgeScanStart, { workspaceId });
    const scan = async () =>
      (
        await rows<{ status: string; errors: unknown }>(
          d.admin,
          sql`select status::text as status, errors from app.knowledge_scans where id = ${scanId}`,
        )
      )[0];
    await settle({ ...d, worker: { ...d.worker, fetchUrl: standInFetch(site.origin) } }, async () =>
      ['done', 'failed', 'cancelled'].includes((await scan())?.status ?? ''),
    );
    const done = await scan();
    if (done?.status !== 'done')
      throw new Error(
        `The website scan ended ${done?.status ?? 'nowhere'}: ${JSON.stringify(done?.errors ?? [])}`,
      );
  } finally {
    await site.close();
  }

  const [count] = await rows<{ published: number; drafts: number; suggestions: number }>(
    d.admin,
    sql`select
          (select count(*)::int from app.knowledge_items where workspace_id = ${workspaceId} and status = 'published') as published,
          (select count(*)::int from app.knowledge_items where workspace_id = ${workspaceId} and status = 'draft') as drafts,
          (select count(*)::int from app.knowledge_suggestions where workspace_id = ${workspaceId} and status = 'pending') as suggestions`,
  );
  return { ...count!, seconds: (Date.now() - started) / 1000 };
}
