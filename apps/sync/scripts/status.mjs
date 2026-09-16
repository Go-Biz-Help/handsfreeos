#!/usr/bin/env node
/**
 * The sync service's health, in words, from its own diagnostics API. It runs inside the service's machine or
 * container, where the admin token already is, so the token never has to leave it:
 *
 *   fly ssh console --app handsfreeos-sync -g app -C "node /config/status.mjs"      (on Fly)
 *   docker exec hfos-sync node /config/status.mjs                                  (after pnpm sync:start)
 *
 * It exits 1 when something needs a person:
 *   - the service can't reach the database, or reports a fatal error;
 *   - the replication slot is `unreserved` or `lost`, or less than half of its WAL budget
 *     (max_slot_wal_keep_size) is left;
 *   - no sync config is serving, or its first copy isn't done;
 *   - with --wait <seconds>: a new sync config is still copying after that long (a stuck deploy). Until then it
 *     waits, and it also waits out a service that is still starting.
 *
 * Options: --wait <seconds> (default 0), --url <base> (default http://127.0.0.1:8080).
 */
/* global AbortSignal */
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const waitSeconds = Number(option('--wait', '0'));
const url = option('--url', 'http://127.0.0.1:8080').replace(/\/+$/, '');
const token = process.env.PS_ADMIN_TOKEN ?? process.env.HFOS_SYNC_ADMIN_TOKEN;
const started = Date.now();
const deadline = started + waitSeconds * 1000;

const size = (bytes) => {
  if (bytes == null) return 'unknown';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
};
const minutes = (ms) => `${Math.round(ms / 60_000)} min`;

if (!token) {
  console.error('PS_ADMIN_TOKEN is not set here, so the diagnostics API can’t be asked.');
  process.exit(1);
}

async function diagnostics() {
  const res = await fetch(`${url}/api/admin/v1/diagnostics`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`the diagnostics API answered ${res.status}`);
  return (await res.json()).data ?? {};
}

/** Every error a sync config reports: its own and each table's. */
const errorsOf = (rules) =>
  rules
    ? [
        ...(rules.errors ?? []),
        ...(rules.connections ?? []).flatMap((c) =>
          (c.tables ?? []).flatMap((t) => t.errors ?? []),
        ),
      ]
    : [];

let data;
for (;;) {
  try {
    data = await diagnostics();
  } catch (e) {
    if (Date.now() < deadline) {
      console.log(`Waiting for the service to answer (${e.message}) …`);
      await sleep(5000);
      continue;
    }
    console.error(`The sync service didn't answer at ${url}: ${e.message}`);
    process.exit(1);
  }
  const copying =
    data.deploying_sync_rules ||
    !data.active_sync_rules?.connections?.[0]?.initial_replication_done;
  const fatal = [...errorsOf(data.active_sync_rules), ...errorsOf(data.deploying_sync_rules)].some(
    (e) => e.level === 'fatal',
  );
  if (!copying || fatal || Date.now() >= deadline) break;
  console.log(`A sync config is still copying, after ${minutes(Date.now() - started)} …`);
  await sleep(10_000);
}

const problems = [];
const lines = [];

for (const c of data.connections ?? []) {
  lines.push(`Database (${c.id}): ${c.connected ? 'connected' : 'NOT connected'}`);
  if (!c.connected)
    problems.push(
      `PowerSync can't reach the database: ${(c.errors ?? []).map((e) => e.message).join('; ') || 'no reason given'}`,
    );
}

/** One sync config's slot: its state, how far behind, and how much WAL it may still hold. */
function describe(label, rules) {
  for (const c of rules.connections ?? []) {
    const budget =
      c.max_slot_wal_keep_size > 0 && c.safe_wal_size != null
        ? c.safe_wal_size / c.max_slot_wal_keep_size
        : null;
    lines.push(
      `${label}: slot ${c.slot_name}, ${c.initial_replication_done ? 'first copy done' : 'first copy NOT done'}, ` +
        `${size(c.replication_lag_bytes)} behind, wal_status ${c.wal_status ?? 'unknown'}, ` +
        (budget == null
          ? `no WAL cap (max_slot_wal_keep_size), so the slot can't be lost but can fill the disk`
          : `${size(c.safe_wal_size)} of its ${size(c.max_slot_wal_keep_size)} WAL budget left`),
    );
    if (c.wal_status === 'unreserved' || c.wal_status === 'lost')
      problems.push(
        `${label}: replication slot ${c.slot_name} is ${c.wal_status}. See "The slot was lost" in docs/operations.md.`,
      );
    else if (budget != null && budget < 0.5)
      problems.push(
        `${label}: less than half the slot's WAL budget is left (${size(c.safe_wal_size)}). PowerSync is falling behind or stopped.`,
      );
  }
  for (const e of errorsOf(rules)) {
    lines.push(`${label} ${e.level}: ${e.message}`);
    if (e.level === 'fatal') problems.push(`${label}: ${e.message}`);
  }
}

if (data.active_sync_rules) describe('Serving', data.active_sync_rules);
else problems.push('No sync config is serving phones.');
if (data.active_sync_rules?.connections?.every((c) => !c.initial_replication_done))
  problems.push('The serving sync config hasn’t finished its first copy.');
if (data.deploying_sync_rules) {
  describe('New sync config (copying)', data.deploying_sync_rules);
  if (waitSeconds > 0)
    problems.push(
      `A new sync config is still copying after ${minutes(Date.now() - started)}: a stuck deploy? See "A deploy that doesn't finish" in docs/operations.md.`,
    );
} else lines.push('New sync config: none copying');

console.log(lines.join('\n'));
if (problems.length) {
  console.error(`\nNeeds attention:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('\nHealthy.');
