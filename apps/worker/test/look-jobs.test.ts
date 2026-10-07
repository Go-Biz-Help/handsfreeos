import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  executeCommand,
  LOOK_BUCKET,
  LOOK_PROBLEMS,
  LOOK_UPLOAD_BUCKET,
  lookBeginUpload,
  lookFind,
  lookOf,
  lookUseUpload,
  organizationCreate,
  type BusinessLook,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from '../src/handlers/index';
import { processJobs } from '../src/jobs';
import { FIND_LOGO_JOB, MAKE_LOGO_JOB } from '../src/look/jobs';
import { emailBrandFor } from '../src/look/public';
import { processOnce } from '../src/outbox';
import { jobs } from '../src/scheduled';
import { testServices, type TestServices } from './helpers';

/**
 * A business's logo, the worker's part (look/jobs.ts): an uploaded picture made into the logo everyone sees, or
 * refused with words saying why, and the website's start page searched for its logo and colour. The website is
 * a stand-in served on a local port, which fetchUrl may reach in tests.
 */

const WORKER_ID = `vitest-look-${process.pid}`;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;

/** A stand-in website: pages and pictures by path, changed by each test. */
interface Site {
  readonly origin: string;
  readonly files: Map<string, { readonly type: string; readonly body: Buffer | string }>;
  readonly requests: string[];
  close(): Promise<void>;
}

async function startSite(): Promise<Site> {
  const files = new Map<string, { type: string; body: Buffer | string }>();
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://site').pathname;
    requests.push(path);
    const file = files.get(path);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': file.type });
    res.end(file.body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    files,
    requests,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/** A red wordmark on a clear background, with margins to trim. */
const wordmark = (color = '#b42318') =>
  sharp({
    create: { width: 520, height: 240, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: { create: { width: 400, height: 120, channels: 4, background: color } },
        left: 60,
        top: 60,
      },
    ])
    .png()
    .toBuffer();

let owner: TestUser;
let site: Site;
let s: TestServices;

beforeAll(async () => {
  owner = await createTestUser('look-jobs-owner');
  site = await startSite();
  s = testServices({ fetchOrigins: [site.origin] });
});
afterAll(async () => {
  await site?.close();
  await closeTestDbs();
});

async function business(name: string): Promise<string> {
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: name, industry: 'hvac' },
    actor(owner),
    meta(),
  );
  return output.workspaceId;
}

const lookIn = async (ws: string): Promise<BusinessLook> => {
  const [w] = await rows<{ settings: Record<string, unknown> }>(
    admin(),
    sql`select settings from app.workspaces where id = ${ws}`,
  );
  return lookOf(w!.settings);
};

async function reserve(ws: string): Promise<void> {
  for (const table of ['outbox', 'scheduled_jobs'])
    await rows(
      admin(),
      sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
          where status = 'pending' and workspace_id = ${ws}`,
    );
}

/** Runs this business's outbox and jobs until `done` says so. */
async function work(ws: string, done: () => Promise<boolean>): Promise<void> {
  const deps = { ...s, workerId: WORKER_ID, batchSize: 50, reservedOnly: true };
  const deadline = Date.now() + 60_000;
  for (;;) {
    await reserve(ws);
    const passes = [await processOnce({ ...deps, handlers }), await processJobs({ ...deps, jobs })];
    if (passes.some((p) => p.retried + p.failed > 0)) {
      const errors = await rows(
        admin(),
        sql`select kind as what, last_error from app.scheduled_jobs where workspace_id = ${ws} and last_error is not null
            union all select event_type, last_error from app.outbox where workspace_id = ${ws} and last_error is not null`,
      );
      throw new Error(`worker work failed: ${JSON.stringify(errors)}`);
    }
    if (await done()) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
  }
}

const jobDone = (ws: string, kind: string) => async () =>
  (
    await rows(
      admin(),
      sql`select 1 from app.scheduled_jobs where workspace_id = ${ws} and kind = ${kind} and status = 'done'`,
    )
  ).length > 0;

/** Uploads a picture as the browser would, after look.begin_upload, and hands it over. */
async function upload(ws: string, data: Buffer, mimeType: string): Promise<string> {
  const { output } = await executeCommand(
    api(),
    lookBeginUpload,
    { workspaceId: ws, name: 'logo', mimeType, sizeBytes: data.length },
    actor(owner),
    meta(),
  );
  await s.store.upload(LOOK_UPLOAD_BUCKET, output.objectPath, data, mimeType);
  await executeCommand(
    api(),
    lookUseUpload,
    { workspaceId: ws, objectPath: output.objectPath },
    actor(owner),
    meta(),
  );
  await work(ws, jobDone(ws, MAKE_LOGO_JOB));
  return output.objectPath;
}

describe('an uploaded logo', () => {
  it('is made into the logo everyone sees, with its colour, and the upload goes', async () => {
    const ws = await business('Upload Look HVAC');
    const objectPath = await upload(ws, await wordmark(), 'image/png');
    const look = await lookIn(ws);
    const id = objectPath.split('/')[1]!.replace(/\.png$/, '');
    expect(look.logo).toMatchObject({
      path: `${ws}/logo/${id}.png`,
      width: 400,
      height: 120,
      from: 'upload',
    });
    expect(look.color).toMatchObject({ hex: '#b42318', from: 'logo' });
    expect(look.upload).toBeNull();
    expect(await s.store.info(LOOK_BUCKET, look.logo!.path)).toMatchObject({
      contentType: 'image/png',
    });
    expect(await s.store.info(LOOK_UPLOAD_BUCKET, objectPath)).toBeNull();

    // It heads the emails the business sends automatically, and only those.
    const [w] = await rows<{ organization_id: string }>(
      admin(),
      sql`select organization_id from app.workspaces where id = ${ws}`,
    );
    const scope = { workspaceId: ws, organizationId: w!.organization_id };
    const brandOf = (sentBy: string | null) =>
      asWorker(testDbs().worker.db, scope, (tx) =>
        emailBrandFor(tx, s.storageUrl, { workspaceId: ws, sentBy, sentByTeammateId: null }),
      );
    expect(await brandOf(null)).toMatchObject({
      name: 'Upload Look HVAC',
      look: { logo: { width: 400, height: 120 }, color: '#b42318' },
    });
    expect((await brandOf(null))!.look.logo!.url).toContain(
      `/storage/v1/object/public/brand/${look.logo!.path}`,
    );
    expect(await brandOf(owner.id)).toBeNull();
  });

  it('says why a picture couldn’t be used, and the upload goes', async () => {
    const ws = await business('Bad Upload HVAC');
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><image href="https://tracker.example/p.png"/></svg>',
    );
    const objectPath = await upload(ws, svg, 'image/svg+xml');
    const look = await lookIn(ws);
    expect(look.logo).toBeNull();
    expect(look.upload).toBeNull();
    expect(look.problem?.message).toBe(LOOK_PROBLEMS.unsafeSvg);
    expect(await s.store.info(LOOK_UPLOAD_BUCKET, objectPath)).toBeNull();
  });
});

describe('the logo on the website', () => {
  const WEBSITE = 'https://brand-look.example/';

  /** A business with a website, asked to look there; the job reads the stand-in site instead. */
  async function findOn(name: string, before?: (ws: string) => Promise<unknown>): Promise<string> {
    const ws = await business(name);
    await rows(
      admin(),
      sql`update app.workspaces set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({ website: WEBSITE })}::jsonb
          where id = ${ws}`,
    );
    await executeCommand(api(), lookFind, { workspaceId: ws }, actor(owner), meta());
    const queued = async () =>
      (
        await rows(
          admin(),
          sql`select 1 from app.scheduled_jobs where workspace_id = ${ws} and kind = ${FIND_LOGO_JOB}`,
        )
      ).length > 0;
    await work(ws, queued);
    await rows(
      admin(),
      sql`update app.scheduled_jobs set payload = jsonb_set(payload, '{url}', to_jsonb(${`${site.origin}/`}::text))
          where workspace_id = ${ws} and kind = ${FIND_LOGO_JOB}`,
    );
    await before?.(ws);
    await work(ws, jobDone(ws, FIND_LOGO_JOB));
    return ws;
  }

  it('finds the logo in the header, after a picture that isn’t one, and keeps its colour', async () => {
    site.files.clear();
    site.files.set('/', {
      type: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><meta name="theme-color" content="#0f766e">
        <link rel="icon" href="/favicon.ico"></head><body>
        <header><img class="logo" src="/img/broken-logo.png" alt="Brand Look"><a href="/"><img src="/img/mark.png" alt="Brand Look"></a></header>
        <main><h1>Brand Look HVAC</h1></main></body></html>`,
    });
    site.files.set('/img/broken-logo.png', { type: 'image/png', body: 'not really a png' });
    site.files.set('/img/mark.png', { type: 'image/png', body: await wordmark() });
    site.requests.length = 0;
    const ws = await findOn('Website Look HVAC');
    const look = await lookIn(ws);
    expect(look.logo).toMatchObject({ width: 400, height: 120, from: 'website' });
    expect(look.color).toMatchObject({ hex: '#b42318', from: 'logo' });
    expect(look.searched).toMatchObject({ url: WEBSITE, found: true });
    expect(await s.store.info(LOOK_BUCKET, look.logo!.path)).toMatchObject({
      contentType: 'image/png',
    });
    expect(site.requests).toEqual(['/robots.txt', '/', '/img/broken-logo.png', '/img/mark.png']);
  });

  it('takes the website’s own colour when it has no logo to find', async () => {
    site.files.clear();
    site.files.set('/', {
      type: 'text/html',
      body: '<!doctype html><html><head><meta name="theme-color" content="#0f766e"></head><body><h1>Plain site</h1></body></html>',
    });
    const ws = await findOn('Colour Look HVAC');
    const look = await lookIn(ws);
    expect(look.logo).toBeNull();
    expect(look.color).toMatchObject({ hex: '#0f766e', from: 'website' });
    expect(look.searched).toMatchObject({ url: WEBSITE, found: false });
  });

  it('keeps out of what robots.txt keeps it off', async () => {
    site.files.clear();
    site.files.set('/robots.txt', { type: 'text/plain', body: 'User-agent: *\nDisallow: /' });
    site.files.set('/', { type: 'text/html', body: '<img class="logo" src="/logo.png">' });
    site.requests.length = 0;
    const ws = await findOn('Robots Look HVAC');
    expect(site.requests).toEqual(['/robots.txt']);
    expect((await lookIn(ws)).searched).toMatchObject({ found: false });
  });

  it('keeps nothing when the website changed while it looked', async () => {
    site.files.clear();
    site.files.set('/', { type: 'text/html', body: '<img class="logo" src="/logo.png">' });
    site.files.set('/logo.png', { type: 'image/png', body: await wordmark('#2d69d8') });
    const ws = await findOn('Moved Look HVAC', (id) =>
      rows(
        admin(),
        sql`update app.workspaces set settings = settings || '{"website": "https://moved.example/"}'::jsonb where id = ${id}`,
      ),
    );
    const look = await lookIn(ws);
    expect(look.logo).toBeNull();
    expect(look.searched).toBeNull();
  });
});
