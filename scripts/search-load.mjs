#!/usr/bin/env node
/**
 * Search's load check (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, How it works, 6). Local stack only: it refuses to
 * start when Supabase or any database it would use isn't on this machine, and never touches the hosted project.
 *
 * Seeds a business with 300,000 messages, 50,000 notes and 20,000 customers, then runs searches through the kernel,
 * as the API does, as an owner, a member and a member whose inbox is narrowed: 200 from the box (quick) and 50 from
 * the Search page (full) each. Prints p50 and p95, and exits 1 when quick p95 passes 400 ms or full p95 passes 2 s.
 * The numbers go in docs/search.md.
 *
 *   node scripts/search-load.mjs
 *
 * Core is TypeScript, so this loads it through the API's tsx. The business it seeds stays in the local database;
 * `pnpm db:reset` clears it.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const fromApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { register } = await import(pathToFileURL(fromApi.resolve('tsx/esm/api')).href);
register();

const { testEnv, testDbs, createTestUser, closeTestDbs } =
  await import('../packages/db/src/testing.ts');
const { rows, sql } = await import('../packages/db/src/client.ts');
const core = await import('../packages/core/src/server.ts');

// ---------- local only ----------
// Every endpoint it can reach, Auth included (it makes its people there first), before it makes anything. A value
// already in the shell wins over .env.local, so each is checked as it will be used.
const env = testEnv();
for (const url of [env.supabaseUrl, env.apiDbUrl, env.workerDbUrl, env.adminDbUrl]) {
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    console.error(
      `Refusing: ${host} isn't this machine. The load check runs on the local stack only.`,
    );
    process.exit(2);
  }
}

const CUSTOMERS = 20_000;
const THREADS = 10_000;
const MESSAGES = 300_000;
const NOTES = 50_000;
const QUICK_RUNS = 200;
const FULL_RUNS = 50;
const QUICK_P95_MS = 400;
const FULL_P95_MS = 2_000;

const admin = testDbs().admin.db;
const api = testDbs().api.db;
const actor = (u) => ({ type: 'human', userId: u.id, email: u.email, claims: u.claims });
const meta = () => ({ correlationId: randomUUID(), channel: 'test' });
const run = (cmd, input, u) =>
  core.executeCommand(api, cmd, input, actor(u), meta()).then((r) => r.output);
const elapsed = (from) => `${((performance.now() - from) / 1000).toFixed(1)} s`;

// ---------- the business ----------
const started = performance.now();
const label = `search-load-${randomUUID().slice(0, 6)}`;
const [owner, member, narrowed] = await Promise.all([
  createTestUser(`${label}-owner`, { fullName: 'Load Owner' }),
  createTestUser(`${label}-member`, { fullName: 'Load Member' }),
  createTestUser(`${label}-narrowed`, { fullName: 'Narrowed Member' }),
]);
const org = await run(
  core.organizationCreate,
  { businessName: 'Load Check Plumbing', timezone: 'America/Chicago' },
  owner,
);
const ws = org.workspaceId;
for (const u of [member, narrowed])
  await rows(
    admin,
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${ws}, ${u.id}, 'member')`,
  );
console.log(`Seeding ${ws}…`);

const FIRST = [
  'Dana',
  'Marcus',
  'Jo',
  'José',
  'Kim',
  'Tom',
  'Priya',
  'Marco',
  'Sam',
  'Ava',
  'Noah',
  'Mia',
  'Liam',
  'Zoë',
  'Eli',
  'Ruth',
  'Omar',
  'Lena',
  'Hugo',
  'Iris',
];
const LAST = [
  'Smith',
  'Smithers',
  'García',
  'Le',
  'Becnel',
  'Nguyen',
  'Johnson',
  'Brown',
  'Davis',
  'Lopez',
  'Martin',
  'Thibodeaux',
  'Landry',
  'Broussard',
  'Hebert',
  'Guidry',
  'Fontenot',
  'Boudreaux',
  'Robichaux',
  'Arceneaux',
];
const SENTENCES = [
  'The water heater is leaking near the gas valve',
  'Can you come Thursday morning to look at the drain',
  'The pilot light keeps going out again',
  'Thanks, the invoice is paid',
  'What time does the tech get here',
  'Our thermostat stopped working last night',
  'Please send the quote for the repipe',
  'The garbage disposal is jammed',
  'Gate code is 4471, the dog is friendly',
  'We need a backflow test for the building',
];
const pick = (list, n) =>
  sql`(${sql.raw(`array[${list.map((s) => `'${s.replace(/'/g, "''")}'`).join(',')}]`)})[1 + ${sql.raw(n)} % ${list.length}]`;

let t = performance.now();
await rows(
  admin,
  sql`insert into app.people (workspace_id, first_name, last_name, phone_e164, email, city, address_line1,
        owner_user_id)
      select ${ws}, ${pick(FIRST, 'n')}, ${pick(LAST, '(n / 7)')},
        '+1504' || lpad((5500000 + n)::text, 7, '0'), 'customer' || n || '@example.com',
        case n % 3 when 0 then 'Metairie' when 1 then 'Kenner' else 'Chalmette' end,
        (100 + n % 900) || ' Oak St', case when n % 5 = 0 then ${member.id}::uuid end
      from generate_series(1, ${CUSTOMERS}) n`,
);
console.log(`  ${CUSTOMERS} customers (${elapsed(t)})`);

t = performance.now();
await rows(
  admin,
  sql`insert into app.conversations (workspace_id, channel, counterpart, person_id, last_message_at, last_preview,
        assignee_user_id)
      select ${ws}, 'sms', p.phone_e164, p.id, now() - make_interval(hours => p.rn::int), 'Thanks!',
        case when p.rn % 4 = 0 then ${narrowed.id}::uuid when p.rn % 4 = 1 then ${member.id}::uuid end
      from (select id, phone_e164, row_number() over (order by created_at, id) as rn
            from app.people where workspace_id = ${ws}) p
      where p.rn <= ${THREADS}`,
);
console.log(`  ${THREADS} threads (${elapsed(t)})`);

t = performance.now();
await rows(
  admin,
  sql`insert into app.messages (workspace_id, conversation_id, channel, direction, status, body_text, occurred_at)
      select ${ws}, c.id, 'sms', case when n % 2 = 0 then 'inbound' else 'outbound' end::app.direction,
        case when n % 2 = 0 then 'received' else 'sent' end::app.message_status,
        ${pick(SENTENCES, 'n')} || ' (' || n || ')', now() - make_interval(mins => n * 5)
      from generate_series(1, ${MESSAGES}) n
      join (select id, row_number() over (order by created_at, id) as rn
            from app.conversations where workspace_id = ${ws}) c on c.rn = 1 + n % ${THREADS}`,
);
console.log(`  ${MESSAGES} messages (${elapsed(t)})`);

t = performance.now();
await rows(
  admin,
  sql`insert into app.activities (workspace_id, kind, body, person_id, occurred_at, actor_type)
      select ${ws}, 'note', ${pick(SENTENCES, '(n * 3)')}, p.id, now() - make_interval(mins => n * 30), 'human'
      from generate_series(1, ${NOTES}) n
      join (select id, row_number() over (order by created_at, id) as rn
            from app.people where workspace_id = ${ws}) p on p.rn = 1 + n % ${CUSTOMERS}`,
);
console.log(`  ${NOTES} notes (${elapsed(t)})`);
await rows(admin, sql`analyze app.people, app.conversations, app.messages, app.activities`);
console.log(`Seeded in ${elapsed(started)}.`);

// ---------- the searches ----------
const SEARCHES = [
  'smith',
  'dana',
  'leaking',
  'water heater',
  '(504) 550-0142',
  'gate code',
  'thermostat',
  'invoice paid',
  'dnaa smtih',
  'zxqv',
  'pilot light',
  'marcus garcia',
  'oak st',
  '1042',
  'repipe quote',
  'kenner',
  'customer123@example.com',
  'backflow',
  'jose',
  'disposal',
];

const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

const ms = (x) => `${Math.round(x)} ms`;

async function measure(who, u, depth, runs) {
  const times = [];
  const slowest = new Map();
  for (let i = 0; i < runs; i++) {
    const q = SEARCHES[i % SEARCHES.length];
    const from = performance.now();
    await core.executeQuery(
      api,
      core.searchEverything,
      { workspaceId: ws, q, depth, perKind: depth === 'quick' ? 3 : 4 },
      actor(u),
      meta(),
    );
    const took = performance.now() - from;
    times.push(took);
    slowest.set(q, Math.max(slowest.get(q) ?? 0, took));
  }
  times.sort((a, b) => a - b);
  const r = {
    who,
    depth,
    runs,
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    max: times.at(-1),
  };
  const worst = [...slowest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(
    `  ${who}, ${depth}: p50 ${ms(r.p50)}, p95 ${ms(r.p95)}; slowest ${worst.map(([q, t]) => `“${q}” ${ms(t)}`).join(', ')}`,
  );
  return r;
}

const results = [];
for (const [who, u] of [
  ['owner', owner],
  ['member', member],
]) {
  results.push(await measure(who, u, 'quick', QUICK_RUNS));
  results.push(await measure(who, u, 'full', FULL_RUNS));
}
// Narrowing the inbox repaints every thread and message, for about two minutes at this size: past a request's
// 15-second statement ceiling, so it's switched on directly, as it's done by hand.
t = performance.now();
await rows(
  admin,
  sql`update app.workspaces set settings = jsonb_set(settings, '{inbox}', '{"perPerson": true}')
      where id = ${ws}`,
);
console.log(`Narrowed the inbox (${elapsed(t)}).`);
results.push(await measure('narrowed member', narrowed, 'quick', QUICK_RUNS));
results.push(await measure('narrowed member', narrowed, 'full', FULL_RUNS));

console.log('\nwho              depth  runs  p50      p95      max');
let over = false;
for (const r of results) {
  const limit = r.depth === 'quick' ? QUICK_P95_MS : FULL_P95_MS;
  if (r.p95 > limit) over = true;
  console.log(
    `${r.who.padEnd(16)} ${r.depth.padEnd(6)} ${String(r.runs).padEnd(5)} ${ms(r.p50).padEnd(8)} ${ms(r.p95).padEnd(8)} ${ms(r.max)}${r.p95 > limit ? `  over ${limit} ms` : ''}`,
  );
}
await closeTestDbs();
process.exit(over ? 1 : 0);
