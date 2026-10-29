/**
 * Settings search finds what core's catalogue lists (packages/core/src/settings/catalog.ts), so the catalogue has to
 * match the screens: a setting row with no entry is never found, an entry that marks nothing jumps to a page and rings
 * nothing, and a link to an anchor that moved lands at the top of the page. The web and the phone have no test runner
 * for this, so it reads their source, as settings-map.test.ts does.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADDON_CATALOG,
  AUTOMATIONS,
  dropdownOf,
  EMAIL_ONLY_ROWS,
  hitLines,
  NOTIFICATION_ROWS,
  ROLE_PERMISSIONS,
  searchSettings,
  SETTINGS,
  settingEntry,
  settingHref,
  settingPhoneTarget,
  settingsByPage,
  settingsCount,
  settingsFound,
  settingsGroupsFor,
  SETTINGS_PAGES,
  settingsSearchGroup,
  settingValueText,
  type SearchEverythingOutput,
} from '../src';

const ROOT = resolve(__dirname, '../../..');
const WEB = join(ROOT, 'apps/web/src');
const PAGES = join(WEB, 'app/app/w/[workspaceId]');
const PHONE = join(ROOT, 'apps/mobile/src/app/app/w/[workspaceId]');

/** Every file under a folder, at any depth, that ends in one of `ext`. */
function filesUnder(dir: string, ext: readonly string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? d.name === 'node_modules'
        ? []
        : filesUnder(join(dir, d.name), ext)
      : ext.some((e) => d.name.endsWith(e))
        ? [join(dir, d.name)]
        : [],
  );
}

const WEB_FILES = filesUnder(WEB, ['.ts', '.tsx']).map((f) => ({
  f,
  src: readFileSync(f, 'utf8'),
}));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** How many times the web marks a key: `setting="key"`, `setting={… 'key' …}` or `settingAttrs('key')`. */
function marksOf(key: string): number {
  const k = escape(key);
  const re = new RegExp(
    `setting="${k}"|setting=\\{[^}]*'${k}'[^}]*\\}|settingAttrs\\('${k}'\\)`,
    'g',
  );
  return WEB_FILES.reduce((n, { src }) => n + (src.match(re)?.length ?? 0), 0);
}

/** How many times the web writes an id literally: `id="quiet-hours"`. */
const idsOf = (anchor: string) =>
  WEB_FILES.reduce(
    (n, { src }) => n + (src.match(new RegExp(`\\bid="${escape(anchor)}"`, 'g'))?.length ?? 0),
    0,
  );

/** A business's page exists on the web. */
const webPageExists = (path: string) => existsSync(join(PAGES, path, 'page.tsx'));

/** The phone's routes under a business, as Expo Router reads its files: groups and `index` left out. */
const PHONE_ROUTES = new Set(
  filesUnder(PHONE, ['.tsx'])
    .map((f) =>
      relative(PHONE, f)
        .replace(/\.tsx$/, '')
        .split('/')
        .filter((part) => !/^\(.*\)$/.test(part) && part !== 'index' && part !== '_layout')
        .join('/'),
    )
    .filter(Boolean),
);

const owner = ROLE_PERMISSIONS.owner as readonly string[];
const admin = ROLE_PERMISSIONS.admin as readonly string[];
const member = ROLE_PERMISSIONS.member as readonly string[];
const RUNNING_OUTREACH = ['outreach'];

/**
 * Literal `<SetRow title="…">` and `<Block title="…">` that aren't settings of their own, each with why. The
 * calendars' builder and the AI teammate's sections are left out altogether (decision 13): their open section lives in
 * React state, and they're under components/calendars and components/ai-team, which this doesn't read.
 */
const NOT_SEARCHABLE: Readonly<Record<string, string>> = {
  'automations/panels.tsx: Timing and value':
    'A heading over Urgent after and A big job starts at, which are found themselves',
  'automations/panels.tsx: What it looks for':
    'The two kinds Unanswered-message alert covers; its row is found by name',
  'automations/panels.tsx: When they go': 'Follow-ups after silence’s steps; its row is found',
  'automations/panels.tsx: Then once a month for': 'A step of Follow-ups after silence',
  'automations/panels.tsx: Ask them to reply C':
    'The switch inside Reply C to confirm, which is found',
  'automations/panels.tsx: When it shows': 'A heading several Adjust sheets share',
  'automations/panels.tsx: Visits that start within': 'A detail of Unconfirmed visit alert',
  'automations/panels.tsx: On its own': 'A heading in Unconfirmed visit alert’s sheet',
  'automations/panels.tsx: Ask customers to confirm visits':
    'Unconfirmed visit alert’s own switch, on its row',
  'automations/panels.tsx: The form': 'Intake questions’ form picker; its row is found',
  'automations/panels.tsx: The message': 'A heading every wording sheet shares',
  'automations/panels.tsx: When': 'A heading several Adjust sheets share',
  'automations/panels.tsx: First text': 'A step of Maintenance due',
  'automations/panels.tsx: Second text, then a card': 'A step of Maintenance due',
  'automations/panels.tsx: At most a day': 'A limit two sheets share',
  'automations/panels.tsx: Days after the due day': 'A detail of Overdue invoices',
  'automations/panels.tsx: Days after it went out': 'A detail of Quotes with no decision',
  'automations/panels.tsx: Sends at': 'End-of-day email’s time; its row is found',
  'automations/panels.tsx: Follow up on its own': 'A switch inside Stale opportunities’ sheet',
  'automations/panels.tsx: Follow-up wording': 'Stale opportunities’ wording',
  'automations/panels.tsx: Who and how many': 'A heading over Gone cold after, which is found',
  'automations/panels.tsx: Not again for': 'A detail of Re-engage dead leads',
  'automations/panels.tsx: What it does': 'The choice inside When a voicemail box answers',
  'automations/panels.tsx: Start': 'A detail of Calling hours for leads, which is found',
  'automations/panels.tsx: End': 'A detail of Calling hours for leads, which is found',
  'automations/panels.tsx: Weekends': 'A detail of Calling hours for leads, which is found',
  'automations/panels.tsx: Tries': 'The choice inside When a lead doesn’t answer, which is found',
  'automations/panels.tsx: Show the box on your pages':
    'The switch inside Ask for an OK to call, which is found',
  'automations/panels.tsx: Call business landlines without a yes':
    'The switch inside Business landlines, which is found',
};

/** Every literal SetRow and Block title on the Settings pages, with whether it carries `setting=`. */
function literalRows(): { where: string; title: string; marked: boolean }[] {
  const dirs = [join(WEB, 'components/settings'), join(PAGES, 'settings')];
  const out: { where: string; title: string; marked: boolean }[] = [];
  for (const file of dirs.flatMap((d) => filesUnder(d, ['.tsx']))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<(SetRow|Block)\b/g)) {
      // The opening tag, up to the `>` outside any braces.
      let depth = 0;
      let i = m.index + m[0].length;
      for (; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '>' && depth === 0) break;
      }
      const tag = src.slice(m.index, i);
      const title = /\btitle="([^"]*)"/.exec(tag)?.[1];
      if (title === undefined) continue;
      out.push({
        where: relative(join(WEB, 'components/settings'), file),
        title,
        marked: /\bsetting=/.test(tag),
      });
    }
  }
  return out;
}

describe('the settings catalogue', () => {
  it('names every entry once, and every anchor once on its page', () => {
    const keys = SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    const anchors = SETTINGS.filter((s) => s.anchor).map((s) => `${s.path}#${s.anchor}`);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it('has every Settings page, and a way to every one that is really there', () => {
    for (const page of SETTINGS_PAGES) {
      const entry = settingEntry(`page.${page.key}`);
      expect(entry, page.key).toBeTruthy();
      expect(webPageExists(`settings${page.path}`), `no page at settings${page.path}`).toBe(true);
    }
    for (const s of SETTINGS.filter((e) => e.path.startsWith('settings')))
      expect(webPageExists(s.path), `${s.key}: no page at ${s.path}`).toBe(true);
  });

  it('marks every setting on its page exactly once', () => {
    for (const s of SETTINGS) {
      if (s.kind !== 'setting' || !s.anchor) continue;
      if (s.key.startsWith('notifications.') || s.key.startsWith('automation.')) continue;
      const count = marksOf(s.key) + idsOf(s.anchor);
      expect(count, `${s.key} (#${s.anchor}) is marked ${count} times on the web`).toBe(1);
    }
    // The rows drawn from core's own lists mark themselves, one each.
    const notifications = readFileSync(
      join(WEB, 'components/settings/notifications-section.tsx'),
      'utf8',
    );
    expect(notifications).toContain('settingAttrs(row.key)');
    expect(notifications).toContain('[...NOTIFICATION_ROWS, ...EMAIL_ONLY_ROWS]');
    const automations = readFileSync(
      join(WEB, 'components/settings/automations/automations-page.tsx'),
      'utf8',
    );
    expect(automations).toContain('id={`automation-${def.id}`}');
  });

  it('gives every setting row on the Settings pages an entry, or says why not', () => {
    const rows = literalRows();
    expect(rows.length).toBeGreaterThan(20);
    const unmarked = rows
      .filter((r) => !r.marked)
      .map((r) => `${r.where}: ${r.title}`)
      .filter((r) => !NOT_SEARCHABLE[r]);
    expect(unmarked, 'a SetRow or Block with no setting= and no reason').toEqual([]);
    // Nothing on the list that's gone or got its entry since.
    const present = new Set(rows.filter((r) => !r.marked).map((r) => `${r.where}: ${r.title}`));
    for (const listed of Object.keys(NOT_SEARCHABLE))
      expect(present.has(listed), `${listed} is on NOT_SEARCHABLE but isn't there`).toBe(true);
  });

  it('resolves every link to a settings anchor, in the web, the worker and the phone', () => {
    const roots = ['apps/web/src', 'apps/worker/src', 'apps/mobile/src'].map((r) => join(ROOT, r));
    const links = roots.flatMap((r) =>
      filesUnder(r, ['.ts', '.tsx']).flatMap((f) =>
        [...readFileSync(f, 'utf8').matchAll(/settings((?:\/[a-z0-9-]+)*)#([a-z0-9-]+)/g)].map(
          (m) => ({ file: relative(ROOT, f), path: `settings${m[1]}`, anchor: m[2]! }),
        ),
      ),
    );
    expect(links.length).toBeGreaterThan(3);
    for (const link of links) {
      const found = SETTINGS.some((s) => s.path === link.path && s.anchor === link.anchor);
      expect(found, `${link.file} links to ${link.path}#${link.anchor}`).toBe(true);
    }
    // The ids emails and tools link to keep their names.
    for (const [key, anchor] of [
      ['texting.quiet_hours', 'quiet-hours'],
      ['texting.rcs', 'rcs'],
      ['usage.founding', 'founding'],
      ['account.notifications', 'notifications'],
    ] as const)
      expect(settingEntry(key)?.anchor).toBe(anchor);
  });

  it('opens every setting the phone has on a screen it really has', () => {
    for (const s of SETTINGS) {
      if (s.phone === 'web') continue;
      const route = s.phone.split('?')[0]!;
      expect(PHONE_ROUTES.has(route), `${s.key}: the phone has no ${route}`).toBe(true);
    }
    // A setting on Settings itself flashes there, and the moments flash on Notifications.
    expect(settingEntry('phone.lock')?.phone).toBe('settings?setting=phone.lock');
    expect(settingEntry('notifications.urgent')?.phone).toBe(
      'settings/notifications?setting=notifications.urgent',
    );
    expect(settingPhoneTarget('ws', settingEntry('texting.quiet_hours')!)).toEqual({
      kind: 'web',
      path: '/app/w/ws/settings/texting#quiet-hours',
    });
  });

  it('lists each Automations row, each notification row and the Adjust fields', () => {
    for (const a of AUTOMATIONS) {
      const entry = settingEntry(`automation.${a.id}`);
      expect(entry?.label, a.id).toBe(a.label);
      expect(entry?.anchor).toBe(`automation-${a.id}`);
    }
    for (const row of [...NOTIFICATION_ROWS, ...EMAIL_ONLY_ROWS])
      expect(settingEntry(row.key)?.label).toBe(row.title);
    const gone = settingEntry('adjust.gone_quiet')!;
    expect(settingHref('ws', gone)).toBe(
      '/app/w/ws/settings/automations?adjust=stale_opportunities#adjust-gone-quiet',
    );
    expect(gone.section).toBe('Stale opportunities');
  });

  it('keeps add-ons off the Settings pages, each under its own name', () => {
    for (const p of SETTINGS_PAGES) {
      expect(p.label).not.toMatch(/add-?ons/i);
      expect(p.path).not.toMatch(/add-?ons/);
    }
    for (const s of SETTINGS.filter((e) => e.kind === 'addon')) {
      expect(s.page, s.key).toBeNull();
      expect(ADDON_CATALOG.some((m) => m.id === s.addon)).toBe(true);
    }
    const deal = settingEntry('addon.realestate.page.settings')!;
    expect(deal.label).toBe('Deal settings');
    expect(deal.needs).toBe('realestate.manage');
    // Shown only where Real Estate runs and to whoever manages it, under its own name.
    const withIt = searchSettings('deal settings', {
      permissions: [...owner, 'realestate.manage', 'realestate.use'],
      addons: ['realestate'],
      surface: 'web',
    });
    expect(withIt.map((h) => [h.entry.key, h.group])).toContainEqual([
      'addon.realestate.page.settings',
      'Real Estate Agent',
    ]);
    const groups = settingsByPage(withIt);
    expect(groups[groups.length - 1]!.label).toBe('Real Estate Agent');
    // The main search's Settings group says where they sit too: under the add-on's name, never "Settings ›".
    const now = { settings: null, timeZone: 'America/Chicago' };
    const lineOf = (hits: typeof withIt, key: string) =>
      hitLines(
        settingsSearchGroup('ws', hits, now)!.items.find((h) => h.id === key)!,
        {
          now: Date.now(),
          timeZone: 'America/Chicago',
        },
      ).line;
    expect(lineOf(withIt, 'addon.realestate.page.settings')).toBe('Real Estate Agent');
    const dealHit = withIt.find((h) => h.entry.key === 'addon.realestate.page.settings')!;
    const aSwitch = {
      ...dealHit,
      entry: { ...dealHit.entry, key: 'addon.realestate.x', path: 'add-ons' },
    };
    expect(lineOf([aSwitch], 'addon.realestate.x')).toBe(
      'Real Estate Agent · Opens the Add-ons page',
    );
    expect(
      searchSettings('deal settings', { permissions: owner, addons: [], surface: 'web' }).map(
        (h) => h.entry.key,
      ),
    ).not.toContain('addon.realestate.page.settings');
  });
});

describe('searchSettings', () => {
  const quiet = () => searchSettings('quiet', { permissions: owner, addons: [], surface: 'web' });

  it('finds “quiet” in the real catalogue, grouped by page, with the count it works out', () => {
    const hits = quiet();
    const labels = hits.map((h) => h.entry.label);
    expect(labels[0]).toBe('Quiet hours');
    expect(hits[0]!.pageLabel).toBe('Texting & calls');
    expect(hits[0]!.entry.section).toBe('Texting rules');
    expect(hits[0]!.marks).toEqual([[0, 5]]);
    for (const label of [
      'Went quiet after a price',
      'Regular customer gone quiet',
      'Channel went quiet',
      'Gone quiet after',
    ])
      expect(labels).toContain(label);
    // Every one of them really holds the word, in what it's called or the words it's known by.
    for (const h of hits)
      expect(
        [h.entry.label, h.entry.section ?? '', ...h.entry.words].join(' ').toLowerCase(),
      ).toContain('quiet');
    const groups = settingsByPage(hits);
    expect(groups.map((g) => g.label)).toEqual(['Business', 'Messages']);
    expect(groups[0]!.pages.map((p) => p.label)).toEqual(['Automations']);
    expect(groups[1]!.pages[0]!.hits.map((h) => h.entry.label)).toEqual(['Quiet hours']);
    const count = settingsCount(hits);
    expect(count.pages).toBe(2);
    expect(count.settings).toBe(hits.length);
    expect(settingsFound(count.settings, count.pages)).toBe(`${hits.length} settings on 2 pages`);
  });

  it('is gated as the Settings menu is', () => {
    // A member may change neither texting nor automations.
    expect(searchSettings('quiet', { permissions: member, addons: [], surface: 'web' })).toEqual(
      [],
    );
    expect(settingsGroupsFor({ permissions: member, addons: [] }).map((g) => g.label)).toEqual([
      'Your account',
    ]);
    // Their own account is theirs.
    expect(
      searchSettings('appearance', { permissions: member, addons: [], surface: 'web' })[0]?.entry
        .key,
    ).toBe('account.appearance');
    // Delete this business needs Delete the business, which admins don't hold.
    const del = (permissions: readonly string[]) =>
      searchSettings('delete this business', { permissions, addons: [], surface: 'web' }).map(
        (h) => h.entry.key,
      );
    expect(del(owner)).toContain('workspace.delete');
    expect(del(admin)).not.toContain('workspace.delete');
    expect(settingEntry('workspace.delete')?.needs).toBe('workspace.delete');
  });

  it('shows the main offer and partners only while an add-on that uses them runs', () => {
    const offer = (addons: readonly string[] | null, permissions = owner) =>
      searchSettings('main offer', { permissions, addons, surface: 'web' }).map((h) => h.entry.key);
    expect(offer([])).not.toContain('page.main_offer');
    expect(offer(RUNNING_OUTREACH)).toContain('page.main_offer');
    // The phone has no list of what runs: an add-on's permission, only theirs while it runs, answers it.
    expect(offer(null)).not.toContain('page.main_offer');
    expect(offer(null, [...owner, 'outreach.use'])).toContain('page.main_offer');
  });

  it('finds a page by its name without every setting on it', () => {
    const hits = searchSettings('texting', { permissions: owner, addons: [], surface: 'web' });
    expect(hits[0]!.entry.key).toBe('page.texting');
    expect(hits.map((h) => h.entry.key)).not.toContain('texting.ring_for');
    expect(settingsCount(hits).settings).toBe(hits.length - 1);
  });

  it('finds a setting by the other words people use, and a typo when nothing else matched', () => {
    const area = searchSettings('service area', { permissions: owner, addons: [], surface: 'web' });
    expect(area[0]!.entry.key).toBe('calendars.territories');
    const typo = searchSettings('quite hours', { permissions: owner, addons: [], surface: 'web' });
    expect(typo[0]!.entry.key).toBe('texting.quiet_hours');
    expect(typo[0]!.close).toBe(true);
    expect(searchSettings('zxqv', { permissions: owner, addons: [], surface: 'web' })).toEqual([]);
    expect(searchSettings('q', { permissions: owner, addons: [], surface: 'web' })).toEqual([]);
  });

  it('lists the phone’s own settings on the phone only', () => {
    const web = searchSettings('face id', { permissions: owner, addons: [], surface: 'web' });
    expect(web.map((h) => h.entry.key)).not.toContain('phone.lock');
    const phone = searchSettings('face id', { permissions: owner, addons: null, surface: 'phone' });
    expect(phone[0]!.entry.key).toBe('phone.lock');
    expect(phone[0]!.group).toBe('This phone');
  });

  it('says what a setting is set to, from the business’s settings', () => {
    const settings = { telephony: { quietHours: { enabled: true, start: '21:00', end: '08:00' } } };
    expect(settingValueText('texting.quiet_hours', settings, 'America/Chicago')).toBe(
      '9:00 PM to 8:00 AM',
    );
    expect(
      settingValueText(
        'texting.quiet_hours',
        { telephony: { quietHours: { enabled: false, start: '21:00', end: '08:00' } } },
        'America/Chicago',
      ),
    ).toBe('Off');
    expect(settingValueText('texting.remind_waiting', null, 'America/Chicago')).toBe(
      'After 10 minutes',
    );
    expect(settingValueText('workspace.hours', null, 'America/Chicago')).toBe(
      'Mon–Fri 8:00 AM–5:00 PM',
    );
    expect(settingValueText('workspace.time_zone', null, 'America/New_York')).toBe('New York time');
    expect(settingValueText('texting.ring_for', null, 'America/Chicago')).toBeNull();
  });

  it('answers the main search’s Settings group, which the dropdown merges in', () => {
    const group = settingsSearchGroup('ws', quiet(), {
      settings: { telephony: { quietHours: { enabled: true, start: '21:00', end: '08:00' } } },
      timeZone: 'America/Chicago',
    })!;
    const first = group.items[0]!;
    expect(first.href).toBe('/app/w/ws/settings/texting#quiet-hours');
    expect(first.tier).toBe(1);
    expect(hitLines(first, { now: Date.now(), timeZone: 'America/Chicago' }).line).toBe(
      'Settings › Texting & calls · 9:00 PM to 8:00 AM',
    );
    const nothing: SearchEverythingOutput = {
      q: 'quiet',
      tooShort: false,
      probes: { looksLike: 'words', phoneE164: null, email: null, number: null },
      total: 0,
      capped: false,
      best: null,
      groups: [],
      archived: null,
      bin: null,
      close: false,
      noneActive: false,
    };
    const dropdown = dropdownOf(nothing, group);
    expect(dropdown.line).toBeNull();
    expect(dropdown.total).toBe(group.items.length);
    expect(dropdown.chips.map((c) => c.kind)).toEqual(['all', 'settings']);
  });

  it('leaves a setting that’s only close out of the main search, so the names’ close matches stand', () => {
    // "bown" (a typo for Brown) is close to a few settings' words, and holds no setting's whole word.
    const typo = searchSettings('bown', { permissions: owner, addons: [], surface: 'web' });
    expect(typo.length).toBeGreaterThan(0);
    expect(typo.every((h) => h.close)).toBe(true);
    expect(settingsSearchGroup('ws', typo, { settings: null, timeZone: 'America/Chicago' })).toBe(
      null,
    );
  });

  it('lists New support tickets and Daily agency digest only to the people whose screens show them', () => {
    const keys = (q: string, more: { staff?: boolean; agency?: boolean } = {}) =>
      (['web', 'phone'] as const).flatMap((surface) =>
        searchSettings(q, {
          permissions: member,
          addons: surface === 'web' ? [] : null,
          surface,
          ...more,
        }).map((h) => h.entry.key),
      );
    expect(keys('support tickets')).not.toContain('notifications.support_tickets');
    expect(keys('support')).not.toContain('notifications.support_tickets');
    expect(keys('agency digest')).not.toContain('notifications.agency_digest');
    expect(keys('digest')).not.toContain('notifications.agency_digest');
    expect(keys('support tickets', { staff: true })).toContain('notifications.support_tickets');
    expect(keys('agency digest', { agency: true })).toContain('notifications.agency_digest');
    expect(settingEntry('notifications.support_tickets')?.only).toBe('staff');
    expect(settingEntry('notifications.agency_digest')?.only).toBe('agency');
    // Everyone else's rows are everyone's.
    expect(keys('morning summary')).toContain('notifications.morning_summary');
  });

  it('reads a typed straight apostrophe as the catalogue’s curly one, and a hyphen as a space', () => {
    const first = (q: string) =>
      searchSettings(q, { permissions: owner, addons: [], surface: 'web' })[0];
    const cant = first("can't answer");
    expect(cant?.entry.label).toBe('Questions the AI can’t answer');
    expect(cant?.close).toBe(false);
    // The marks fit the label as written, curly apostrophe and all.
    expect(cant?.marks.map(([s, e]) => cant.entry.label.slice(s, e))).toEqual(['can’t', 'answer']);
    expect(first('can’t answer')?.entry.key).toBe(cant?.entry.key);
    expect(first('opt-out')?.entry.label).toBe('STOP, START and HELP');
  });

  it('stays quick with a long pasted word', () => {
    const started = performance.now();
    searchSettings('x'.repeat(1000), { permissions: owner, addons: [], surface: 'web' });
    searchSettings('https://example.com/a/very/long/pasted/address/of/many/parts', {
      permissions: owner,
      addons: [],
      surface: 'web',
    });
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('settingsFound', () => {
  it('counts settings and pages', () => {
    expect(settingsFound(3, 2)).toBe('3 settings on 2 pages');
    expect(settingsFound(1, 1)).toBe('1 setting on 1 page');
    expect(settingsFound(0, 1)).toBe('1 page');
  });
});
