import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  applyTeammatePatch,
  TEAMMATE_TOOL_NAMES,
  TEAMMATE_TOOLS,
  TEAMMATE_TURN_ENDERS,
  teammateConfigFromPreset,
  teammateToolByName,
  teammateTools,
  UNVERIFIED_CHAT_HIDDEN,
  type TeammateConfig,
  type TeammateTool,
} from '../src/ai-team/index';
import { toolInputSchema } from '../src/assistant/tools';
import { DALE, presetContext, SERVICE_CAL } from './ai-team-fixtures';

const tool = (name: string): TeammateTool => teammateToolByName.get(name)!;
const names = (config: TeammateConfig, unverifiedChat = false) =>
  teammateTools(config, { unverifiedChat }).map((t) => t.name);

/** Every property name anywhere in a JSON schema: nested objects, list items, unions. */
function propertyNames(schema: unknown, out: string[] = []): string[] {
  if (Array.isArray(schema)) for (const s of schema) propertyNames(s, out);
  else if (schema && typeof schema === 'object')
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'properties' && value && typeof value === 'object')
        out.push(...Object.keys(value));
      propertyNames(value, out);
    }
  return out;
}

const FORBIDDEN =
  /^(?:person|people|customer|contact|conversation|thread|workspace|organization|org|lead|user|assignee|assigneeUser|member|teammate|visitor|widget)(?:_?ids?)$/i;

describe('the registry', () => {
  it('has the plan’s tools, each with a skill and an autonomy', () => {
    expect(TEAMMATE_TOOLS.map((t) => [t.name, t.skill, t.autonomy])).toEqual([
      ['search_knowledge', 'answer', 'auto'],
      ['find_times', 'book', 'auto'],
      ['my_appointments', 'book', 'auto'],
      ['book', 'book', 'draft'],
      ['reschedule', 'book', 'draft'],
      ['cancel', 'book', 'draft'],
      ['record_answers', 'qualify', 'auto'],
      ['ask_form', 'qualify', 'auto'],
      ['answer_form', 'qualify', 'auto'],
      ['move_stage', 'qualify', 'auto'],
      ['update_customer', 'core', 'auto'],
      ['add_note', 'core', 'auto'],
      ['create_task', 'core', 'auto'],
      ['offer_discount', 'discounts', 'approval'],
      ['hand_off', 'core', 'auto'],
      ['reply', 'core', 'draft'],
      ['no_reply', 'core', 'auto'],
    ]);
    expect(TEAMMATE_TOOL_NAMES).toEqual(TEAMMATE_TOOLS.map((t) => t.name));
    expect([...TEAMMATE_TURN_ENDERS].sort()).toEqual(['hand_off', 'no_reply', 'reply']);
  });

  it('holds back only what reaches the customer, and a discount always waits for a person', () => {
    const draft = TEAMMATE_TOOLS.filter((t) => t.autonomy === 'draft').map((t) => t.name);
    expect(draft).toEqual(['book', 'reschedule', 'cancel', 'reply']);
    expect(TEAMMATE_TOOLS.filter((t) => t.autonomy === 'approval').map((t) => t.name)).toEqual([
      'offer_discount',
    ]);
    expect(TEAMMATE_TOOLS.map((t) => t.name)).not.toContain('refund');
    for (const t of TEAMMATE_TOOLS) expect(t.name).not.toMatch(/delete|archive|refund/);
  });

  it('gives every tool a strict object input and a description', () => {
    for (const t of TEAMMATE_TOOLS) {
      const schema = toolInputSchema(t) as { type: string; additionalProperties: unknown };
      expect(schema.type, t.name).toBe('object');
      expect(schema.additionalProperties, t.name).toBe(false);
      expect(t.description.length, t.name).toBeGreaterThan(40);
    }
  });
});

describe('ids the model could misuse', () => {
  it('no tool input takes a person, conversation or workspace id', () => {
    for (const t of TEAMMATE_TOOLS) {
      const props = propertyNames(toolInputSchema(t));
      for (const p of props) expect(p, `${t.name}.${p}`).not.toMatch(FORBIDDEN);
      expect(props, t.name).not.toContain('id');
    }
  });

  it('the walk reaches nested properties, so the check above can’t pass by missing them', () => {
    expect(propertyNames(toolInputSchema(tool('record_answers')))).toEqual(
      expect.arrayContaining(['answers', 'questionId', 'answer']),
    );
    expect(propertyNames(toolInputSchema(tool('update_customer')))).toEqual(
      expect.arrayContaining(['address', 'postalCode']),
    );
    const planted = { input: z.object({ a: z.array(z.object({ personId: z.uuid() })) }) };
    expect(propertyNames(toolInputSchema(planted))).toContain('personId');
  });

  it('refuses an id the model adds anyway', () => {
    expect(tool('add_note').input.safeParse({ body: 'x', personId: DALE }).success).toBe(false);
    expect(
      tool('book').input.safeParse({
        calendarId: SERVICE_CAL,
        startsAt: '2026-09-17T09:00:00-05:00',
        conversationId: DALE,
      }).success,
    ).toBe(false);
  });
});

describe('inputs', () => {
  it('turn local times into UTC and keep whole days as dates', () => {
    expect(
      tool('book').input.parse({ calendarId: SERVICE_CAL, startsAt: '2026-09-17T09:00:00-05:00' }),
    ).toEqual({ calendarId: SERVICE_CAL, startsAt: '2026-09-17T14:00:00.000Z' });
    expect(tool('find_times').input.parse({ calendarId: SERVICE_CAL, from: '2026-09-17' })).toEqual(
      {
        calendarId: SERVICE_CAL,
        from: '2026-09-17',
      },
    );
  });

  it('refuse empty or unknown values', () => {
    expect(tool('update_customer').input.safeParse({}).success).toBe(false);
    expect(tool('update_customer').input.safeParse({ email: 'not an email' }).success).toBe(false);
    expect(tool('hand_off').input.safeParse({ reason: 'bored', note: 'x' }).success).toBe(false);
    expect(
      tool('offer_discount').input.safeParse({ percent: 80, reason: 'x', message: 'y' }).success,
    ).toBe(false);
    expect(tool('record_answers').input.safeParse({ answers: [] }).success).toBe(false);
  });
});

describe('teammateTools', () => {
  const responder = teammateConfigFromPreset('lead_responder', presetContext);
  const coordinator = teammateConfigFromPreset('appointment_coordinator', presetContext);

  it('turns on the tools of the skills that are on', () => {
    expect(names(responder)).toEqual([
      'search_knowledge',
      'update_customer',
      'add_note',
      'create_task',
      'hand_off',
      'reply',
      'no_reply',
    ]);
    expect(names(coordinator)).toEqual([
      'search_knowledge',
      'find_times',
      'my_appointments',
      'book',
      'reschedule',
      'cancel',
      'update_customer',
      'add_note',
      'create_task',
      'hand_off',
      'reply',
      'no_reply',
    ]);
    const qualifier = applyTeammatePatch(
      teammateConfigFromPreset('lead_qualifier', presetContext),
      {
        money: { discounts: 'with_approval' },
      },
    );
    expect(names(qualifier)).toEqual(
      expect.arrayContaining(['record_answers', 'move_stage', 'offer_discount']),
    );
    expect(names(applyTeammatePatch(responder, { answer: { enabled: false } }))).not.toContain(
      'search_knowledge',
    );
  });

  it('follows the reschedule and cancel switches', () => {
    const neither = applyTeammatePatch(coordinator, { book: { reschedule: false, cancel: false } });
    expect(names(neither)).not.toContain('reschedule');
    expect(names(neither)).not.toContain('cancel');
    expect(names(neither)).toContain('book');
  });

  it('hides a matched customer’s bookings and details from an unverified chat visitor', () => {
    expect(names(coordinator, true)).toEqual([
      'search_knowledge',
      'find_times',
      'book',
      'add_note',
      'create_task',
      'hand_off',
      'reply',
      'no_reply',
    ]);
    for (const hidden of UNVERIFIED_CHAT_HIDDEN)
      expect(names(coordinator, true)).not.toContain(hidden);
  });

  it('always lets it end its turn', () => {
    const bare = applyTeammatePatch(responder, {
      respond: { enabled: false },
      answer: { enabled: false },
    });
    expect(names(bare)).toEqual(expect.arrayContaining([...TEAMMATE_TURN_ENDERS]));
  });
});
