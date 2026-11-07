import type { AiToolDefinition } from '@hfos/ai';
import {
  ADDON_SERVER_MODULES,
  allAddonAiTools,
  assistantTools,
  screenPlace,
} from '@hfos/core/server';
import { describe, expect, it } from 'vitest';
import { contextText, lastingText, turnText, type PromptContext } from '../src/assistant/prompt';
import { ADDON_WORKER_MODULES } from '../src/addons/modules';
import { assistantRequest } from '../src/assistant/runtime';
import { allAddonActionTools } from '../src/assistant/tools-addons';
import { allScreenActionTools } from '../src/assistant/tools-screen-actions';

const PROMPT: PromptContext = {
  businessName: 'Lone Star HVAC',
  personName: 'Dale',
  role: 'Owner',
  timezone: 'America/Chicago',
  now: new Date('2026-09-27T14:16:00Z'),
  pipelines: [{ name: 'Sales', stages: [{ id: 's1', name: 'New', kind: 'open' }] }],
  team: [{ userId: 'u1', fullName: 'Dale', role: 'owner' }],
  calendars: [],
  services: [],
  page: null,
  workflows: [],
  approvals: [{ id: 'a1', workflow: 'Follow-up', customer: 'Mike', what: 'a text' }],
  knowledge: { brief: 'What they do: HVAC.', rules: 'State only facts.' },
  attention: null,
};

describe('Assistant context (PERF-M20)', () => {
  it('keeps what stays the same apart from what changes each question, so it can be cached', () => {
    const later: PromptContext = {
      ...PROMPT,
      now: new Date('2026-09-27T18:40:00Z'),
      page: { type: 'person', id: 'p1', label: 'Mike Johnson', next: null },
      approvals: [],
      spoken: true,
    };
    expect(lastingText(later)).toBe(lastingText(PROMPT));
    expect(lastingText(PROMPT)).toContain('Business: Lone Star HVAC.');
    expect(lastingText(PROMPT)).toContain('<business_profile>');
    expect(lastingText(PROMPT)).not.toContain('It is ');
    expect(turnText(PROMPT)).toMatch(/^It is Sunday, September 27, 2026/);
    expect(turnText(PROMPT)).toContain('(approval id a1)');
    expect(turnText(later)).toContain('On screen now: Mike Johnson');
    expect(contextText(PROMPT)).toBe(`${lastingText(PROMPT)}\n${turnText(PROMPT)}`);
  });

  it('lists the AI teammate’s drafts beside the workflow approvals, says when more wait, and names pipelines by id', () => {
    const waiting = turnText({
      ...PROMPT,
      moreApprovals: true,
      teammateDrafts: [{ id: 'd1', what: 'Ava’s reply to Mike Johnson' }],
    });
    expect(waiting).toContain(
      'Workflow approvals waiting on this person (the newest 10 waiting; list_workflow_approvals reads the rest):',
    );
    expect(waiting).toContain('- Ava’s reply to Mike Johnson (draft id d1)');
    expect(turnText(PROMPT)).not.toContain('draft id');
    expect(
      lastingText({
        ...PROMPT,
        pipelines: [{ id: 'p1', name: 'Sales', stages: PROMPT.pipelines[0]!.stages }],
      }),
    ).toContain('- Sales (pipeline id p1): New [open] (stage id s1)');
  });

  it('says when there are more workflows than it lists, and how to read a run on screen', () => {
    const flows = Array.from({ length: 25 }, (_, i) => ({
      id: `w${i}`,
      name: `Flow ${i}`,
      status: 'active',
      trigger: 'When someone starts it',
    }));
    expect(lastingText({ ...PROMPT, workflows: flows, workflowsTotal: 31 })).toContain(
      'Workflows (the first 25 of 31; list_workflows has the rest; their ids start, pause and resume them):',
    );
    expect(lastingText({ ...PROMPT, workflows: flows })).toContain(
      'Workflows (their ids start, pause and resume them):',
    );
    expect(
      turnText({
        ...PROMPT,
        page: { type: 'workflow_run', id: 'r1', label: 'a run of Follow-up', next: null },
      }),
    ).toContain(
      'On screen now: a run of Follow-up (workflow_run id r1). get_workflow_run reads it step by step.',
    );
  });

  it('says which page or setting is open when no record is, with the ids in its address', () => {
    const ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const on = (path: string) => turnText({ ...PROMPT, place: screenPlace(path) });
    expect(on(`/settings/calendars/${ID}`)).toContain(
      `On screen now: Calendars in the setup (Settings → Calendars; its area is calendars), showing calendar id ${ID}.`,
    );
    expect(on(`/money/invoices/${ID}`)).toContain(
      `On screen now: An invoice (Money → Invoices, then press the invoice), showing invoice id ${ID}.`,
    );
    expect(on('/audit')).toContain('On screen now: Audit log (Audit log).');
    // The Calendar's view and day, and whose it is, so "this week" means the week that's open.
    expect(on(`/calendar?view=week&date=2026-11-09&people=${ID}`)).toContain(
      `, on the week view of 2026-11-09, showing user id ${ID}.`,
    );
    expect(on(`/customers/companies/${ID}`)).toContain(
      'On screen now: A company’s page (Contacts → Companies, then press the company)',
    );
    // A pet, vehicle or property on screen is a record "this" can mean, read with get_record_details.
    expect(
      turnText({ ...PROMPT, page: { type: 'custom_record', id: ID, label: 'Rex (pet)' } }),
    ).toContain(
      `On screen now: Rex (pet), one of the business’s own records (customRecordId ${ID}). "It" or "this" usually means this record; get_record_details with recordType record reads it`,
    );
    // A conversation on screen says who it's with, by their id, so "book her" needs no search.
    const convo = turnText({
      ...PROMPT,
      page: {
        type: 'conversation',
        id: ID,
        label: 'Instagram messages with Dana Reyes',
        related: 'It is with Dana Reyes (person id p1).',
      },
    });
    expect(convo).toContain(
      `On screen now: Instagram messages with Dana Reyes (conversation id ${ID}).`,
    );
    expect(convo).toContain('It is with Dana Reyes (person id p1).');
    expect(on(`/a/realestate/deals/${ID}`)).toContain(
      `On screen now: the page at /a/realestate/deals/${ID}, which isn’t one of the places above, showing deal id ${ID}.`,
    );
    // A record on screen is said as before, and a screen that didn't say keeps the old line.
    expect(
      turnText({
        ...PROMPT,
        page: { type: 'person', id: 'p1', label: 'Mike Johnson', next: null },
        place: screenPlace('/customers/people/p1'),
      }),
    ).toContain('On screen now: Mike Johnson');
    expect(turnText(PROMPT)).toContain('No customer, lead or appointment is on screen.');
    // The place changes per question, so it never reaches the part that's cached.
    expect(lastingText({ ...PROMPT, place: screenPlace('/audit') })).toBe(lastingText(PROMPT));
  });
});

describe('what every question sends (assistantRequest)', () => {
  const addonTools = allAddonAiTools(ADDON_SERVER_MODULES);
  const inView = (tools: readonly AiToolDefinition[]) =>
    tools.filter((t) => !t.deferred).map((t) => t.name);

  it('keeps the same short list in view however many add-on tools come with it', () => {
    const searching = { toolSearch: true };
    const core = assistantRequest(assistantTools, searching);
    const all = assistantRequest([...assistantTools, ...addonTools], searching);
    expect(addonTools.filter((t) => t.addonId === 'outreach').length).toBeGreaterThan(60);
    expect(inView(all.tools)).toEqual(inView(core.tools));
    expect(inView(core.tools).length).toBeLessThan(30);
    expect(all.system).toBe(core.system);
    expect(all.tools.filter((t) => t.name.startsWith('outreach_')).every((t) => t.deferred)).toBe(
      true,
    );
    // The add-ons' worker actions too: found by search, never in view.
    const actions = allAddonActionTools(ADDON_WORKER_MODULES);
    expect(actions.length).toBeGreaterThan(10);
    const withActions = assistantRequest([...assistantTools, ...addonTools, ...actions], searching);
    expect(inView(withActions.tools)).toEqual(inView(core.tools));
    expect(withActions.system).toBe(core.system);
    // The screens' own commands too.
    const screens = allScreenActionTools();
    expect(screens.length).toBeGreaterThan(100);
    const withScreens = assistantRequest([...assistantTools, ...screens], searching);
    expect(inView(withScreens.tools)).toEqual(inView(core.tools));
    expect(withScreens.system).toBe(core.system);
  });

  it('works out each tool once, so the next question sends the very same definitions', () => {
    const offered = [...assistantTools, ...addonTools];
    const first = assistantRequest(offered, { toolSearch: true });
    const next = assistantRequest(offered, { toolSearch: true });
    expect(next).toEqual(first);
    next.tools.forEach((t, i) => expect(t.inputSchema).toBe(first.tools[i]!.inputSchema));
  });

  it('sends every core tool in view when the model can’t search, and add-ons’ tools still deferred', () => {
    const plain = assistantRequest([...assistantTools, ...addonTools], { toolSearch: false });
    expect(inView(plain.tools)).toEqual(assistantTools.map((t) => t.name));
  });
});
