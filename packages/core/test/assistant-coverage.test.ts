/**
 * Everything a person can do, the Assistant can do (the owner, 2026-10-26 and 2026-10-27): every command a screen on
 * the web or the phone runs is one of the Assistant's own tools, an add-on's, a screen action (a tool made from the
 * command itself), or kept out for a reason; and every setting row says which tool changes it, or why the Assistant
 * doesn't. A new screen command or setting fails here until it's one of those, or on the Not yet list. The web and
 * the phone have no test runner for this, so it reads their source, as settings-catalog.test.ts does.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  ADDON_SERVER_MODULES,
  allAddonAiTools,
  ASSISTANT_NOT_YET,
  assistantTools,
  hasWorkspacePermission,
  isOrgPermission,
  isStaffPermission,
  NEVER_FOR_THE_ASSISTANT,
  registry,
  SCREEN_ACTIONS,
  screenActionName,
  screenActionTools,
  screenReadTools,
  SETTING_TOOLS,
  SETTINGS,
  SETTINGS_NEVER,
  SETTINGS_NOT_YET,
  SETTINGS_PAGES,
  toolInputSchema,
} from '../src/server';

const ROOT = join(__dirname, '..', '..', '..');

/** Every source file under a folder. */
function filesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return name === 'node_modules' || name === '__tests__' ? [] : filesIn(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** Each command the web and the phone run, with the files that run it. */
const screenCommands = (() => {
  const found = new Map<string, string[]>();
  for (const dir of ['apps/web/src', 'apps/mobile/src'])
    for (const file of filesIn(join(ROOT, dir)))
      for (const m of readFileSync(file, 'utf8').matchAll(/\/v1\/commands\/([a-z_]+\.[a-z_.]+)/g))
        found.set(m[1]!, [...(found.get(m[1]!) ?? []), relative(ROOT, file)]);
  return found;
})();

/**
 * What the Assistant's own tools run: every name its code writes out (coverage.ts, which lists what it doesn't, left
 * out). So a tool's command is written in full, never built from pieces.
 */
const ownNames = new Set(
  ['apps/worker/src/assistant', 'packages/core/src/assistant']
    .flatMap((d) => filesIn(join(ROOT, d)))
    .filter((f) => !f.endsWith('coverage.ts'))
    .flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/'([a-z_]+\.[a-z_.]+)'/g)].map((m) => m[1]!),
    ),
);
const addonTools = allAddonAiTools(ADDON_SERVER_MODULES);
const addonCommands = new Set<string>(addonTools.map((t) => t.op.name));
const notYet = new Set(ASSISTANT_NOT_YET.flatMap((p) => p.actions));
const actions = screenActionTools(registry);

describe('what the Assistant can do', () => {
  it('does every command a screen runs, or keeps it out for a reason', () => {
    const missing = [...screenCommands.keys()].filter(
      (name) =>
        !ownNames.has(name) &&
        !addonCommands.has(name) &&
        !(name in SCREEN_ACTIONS) &&
        !(name in NEVER_FOR_THE_ASSISTANT) &&
        !notYet.has(name),
    );
    // Each one: add it to SCREEN_ACTIONS in packages/core/src/assistant/coverage.ts (a tool made from the command), give
    // it a tool of its own, or add it to NEVER_FOR_THE_ASSISTANT or ASSISTANT_NOT_YET with the reason.
    expect(missing.map((name) => `${name} (${screenCommands.get(name)!.join(', ')})`)).toEqual([]);
  });

  it('lists each command once, as the registry has it, while a screen runs it', () => {
    const listed = [
      ...Object.keys(SCREEN_ACTIONS),
      ...Object.keys(NEVER_FOR_THE_ASSISTANT),
      ...notYet,
    ];
    expect(listed.filter((n, i) => listed.indexOf(n) !== i)).toEqual([]);
    expect(listed.filter((n) => !registry.command(n))).toEqual([]);
    expect(listed.filter((n) => !screenCommands.has(n))).toEqual([]);
  });

  it('never lists one its own tools or an add-on’s already do', () => {
    const listed = [
      ...Object.keys(SCREEN_ACTIONS),
      ...Object.keys(NEVER_FOR_THE_ASSISTANT),
      ...notYet,
    ];
    expect(listed.filter((n) => ownNames.has(n) || addonCommands.has(n))).toEqual([]);
    for (const page of ASSISTANT_NOT_YET) {
      expect(page.actions.length, page.page).toBeGreaterThan(0);
      expect(page.why.trim().length, page.page).toBeGreaterThan(0);
    }
  });

  it('makes a tool of each screen action, named once, after nothing else', () => {
    expect(actions.map((t) => t.command.name)).toEqual(Object.keys(SCREEN_ACTIONS));
    const taken = new Set([
      ...assistantTools.map((t) => t.name),
      ...addonTools.map((t) => t.name),
      ...screenReadTools(registry).map((t) => t.name),
    ]);
    expect(actions.filter((t) => taken.has(t.name)).map((t) => t.name)).toEqual([]);
    expect(new Set(actions.map((t) => t.name)).size).toBe(actions.length);
    for (const t of actions) {
      expect(t.name, t.name).toBe(screenActionName(t.command.name));
      expect(t.name, t.name).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      expect(() => toolInputSchema(t), t.name).not.toThrow();
      expect(toolInputSchema(t)['type'], t.name).toBe('object');
      // A change waits for the person's OK; only risk 0 (setting a note aside) runs on its own.
      expect(t.autonomy, t.name).toBe(t.command.risk === 0 ? 'auto' : 'confirm');
      // The riskiest say on their card what they cost or what can't be taken back.
      if (t.command.risk === 4) expect(t.warning, t.name).toBeTruthy();
    }
  });

  it('acts only in the business it was asked in, except on HandsFreeOS’s own desk', () => {
    for (const t of actions) {
      const keys = Object.keys(t.input.shape);
      if (t.staff) {
        expect(t.scope, t.name).toEqual([]);
        continue;
      }
      expect(keys, t.name).not.toContain('workspaceId');
      expect(keys, t.name).not.toContain('organizationId');
    }
  });

  it('offers each to the people the screen is for, and the staff ones to staff alone', () => {
    for (const t of actions) {
      // The Assistant offers by the business's permissions and staff roles; an agency's is offered on workspace.update.
      expect(isOrgPermission(t.permission), t.name).toBe(false);
      if (t.staff) expect(hasWorkspacePermission('owner', t.permission), t.name).toBe(false);
      else expect(isStaffPermission(t.permission), t.name).toBe(false);
    }
    const member = actions.filter((t) => hasWorkspacePermission('member', t.permission));
    const owner = actions.filter((t) => hasWorkspacePermission('owner', t.permission));
    expect(member.map((t) => t.name)).toContain('do_conversation_close_all');
    expect(member.map((t) => t.name)).not.toContain('do_telephony_disable');
    expect(owner.map((t) => t.name)).toContain('do_telephony_disable');
    expect(owner.map((t) => t.name)).not.toContain('do_support_ticket_reply');
  });
});

/** The schema at a path in a tool's input, through what only wraps it (optional, nullable, a default, a pipe). */
function schemaAt(input: z.ZodObject, path: string): z.ZodType | null {
  let at: z.ZodType = input;
  for (const key of path.split('.')) {
    at = bare(at);
    if (!(at instanceof z.ZodObject)) return null;
    const next = (at.shape as Record<string, z.ZodType>)[key];
    if (!next) return null;
    at = next;
  }
  return bare(at);
}
function bare(s: z.ZodType): z.ZodType {
  let at = s as z.ZodType & { _zod: { def: Record<string, unknown> } };
  for (let i = 0; i < 10; i++) {
    const def = at._zod.def;
    const inner = (def['innerType'] ?? (def['type'] === 'pipe' ? def['in'] : undefined)) as
      typeof at | undefined;
    if (!inner) break;
    at = inner;
  }
  return at;
}

describe('what the Assistant can set', () => {
  const tools = new Map<string, { input: z.ZodObject }>([
    ...assistantTools.map((t) => [t.name, t as { input: z.ZodObject }] as const),
    ...actions.map((t) => [t.name, t] as const),
    ...addonTools.map((t) => [t.name, t] as const),
  ]);
  const rows = SETTINGS.filter((s) => s.kind !== 'page');
  const pageOf = (s: (typeof rows)[number]) => s.page ?? s.addon ?? 'phone';

  it('says which tool changes each setting row, or why it doesn’t, page by page', () => {
    const unsaid = rows.filter(
      (s) =>
        !(s.key in SETTING_TOOLS) &&
        !(s.key in SETTINGS_NEVER) &&
        !SETTINGS_NOT_YET.includes(pageOf(s)),
    );
    // Each one: add it to SETTING_TOOLS (the tool and its input) or SETTINGS_NEVER in coverage.ts.
    expect(unsaid.map((s) => `${s.key} (${s.label})`)).toEqual([]);
  });

  it('names rows that are there, once each', () => {
    const keys = new Set(rows.map((s) => s.key));
    const named = [...Object.keys(SETTING_TOOLS), ...Object.keys(SETTINGS_NEVER)];
    expect(named.filter((k) => !keys.has(k))).toEqual([]);
    expect(named.filter((k, i) => named.indexOf(k) !== i)).toEqual([]);
  });

  it('keeps the pages still to check in menu order, each with rows to check', () => {
    const order = [...SETTINGS_PAGES.map((p) => p.key as string), 'phone', 'realestate'];
    expect(SETTINGS_NOT_YET.every((p) => order.includes(p))).toBe(true);
    expect([...SETTINGS_NOT_YET].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual([
      ...SETTINGS_NOT_YET,
    ]);
    for (const page of SETTINGS_NOT_YET)
      expect(
        rows.some((s) => pageOf(s) === page),
        page,
      ).toBe(true);
  });

  it('names a tool that takes each setting, with its choice among the ones it takes', () => {
    for (const [key, ways] of Object.entries(SETTING_TOOLS)) {
      expect(ways.length, key).toBeGreaterThan(0);
      for (const way of ways) {
        const tool = tools.get(way.tool);
        expect(tool, `${key}: ${way.tool}`).toBeTruthy();
        const field = schemaAt(tool!.input, way.field);
        expect(field, `${key}: ${way.tool}.${way.field}`).toBeTruthy();
        if (way.value === undefined) continue;
        const one = field instanceof z.ZodArray ? (field.element as z.ZodType) : field!;
        expect(
          one.safeParse(way.value).success,
          `${key}: ${way.tool}.${way.field} ${way.value}`,
        ).toBe(true);
      }
    }
  });
});
