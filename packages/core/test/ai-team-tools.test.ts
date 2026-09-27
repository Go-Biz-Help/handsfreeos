import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  applyTeammatePatch,
  type TeammatePatch,
  TEAMMATE_TOOL_NAMES,
  TEAMMATE_TOOLS,
  TEAMMATE_TURN_ENDERS,
  teammateConfigFromPreset,
  teammateToolByName,
  teammateTools,
  STRANGER_IN_CHAT_HIDDEN,
  UNVERIFIED_CHAT_HIDDEN,
  UNVERIFIED_CHAT_ONLY,
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
      ['read_call_transcript', 'core', 'auto'],
      ['find_times', 'book', 'auto'],
      ['check_service_area', 'book', 'auto'],
      ['my_appointments', 'book', 'auto'],
      ['job_status', 'core', 'auto'],
      ['book', 'book', 'draft'],
      ['reschedule', 'book', 'draft'],
      ['book_repeating', 'book', 'draft'],
      ['join_waitlist', 'book', 'draft'],
      ['add_to_appointment', 'book', 'draft'],
      ['cancel', 'book', 'draft'],
      ['record_answers', 'qualify', 'auto'],
      ['ask_form', 'qualify', 'auto'],
      ['answer_form', 'qualify', 'auto'],
      ['move_stage', 'qualify', 'auto'],
      ['open_deal', 'deals', 'auto'],
      ['set_deal_value', 'deals', 'auto'],
      ['close_deal', 'deals', 'auto'],
      ['update_customer', 'core', 'auto'],
      ['add_note', 'core', 'auto'],
      ['create_task', 'core', 'auto'],
      ['send_verification_code', 'core', 'auto'],
      ['check_verification_code', 'core', 'auto'],
      ['note_photos', 'photos', 'auto'],
      ['offer_discount', 'discounts', 'approval'],
      ['my_bills', 'bills', 'auto'],
      ['send_payment_link', 'bills', 'approval'],
      ['propose_bill', 'newBills', 'approval'],
      ['my_quotes', 'quotes', 'auto'],
      ['send_quote', 'quotes', 'approval'],
      ['propose_quote', 'buildQuotes', 'approval'],
      ['record_quote_answer', 'quotes', 'approval'],
      ['offer_plan', 'plans', 'approval'],
      ['hand_off', 'core', 'auto'],
      ['reply', 'core', 'draft'],
      ['end_call', 'core', 'auto'],
      ['confirm_visit', 'core', 'auto'],
      ['no_more_calls', 'core', 'auto'],
      ['no_reply', 'core', 'auto'],
    ]);
    expect(TEAMMATE_TOOL_NAMES).toEqual(TEAMMATE_TOOLS.map((t) => t.name));
    expect([...TEAMMATE_TURN_ENDERS].sort()).toEqual(['end_call', 'hand_off', 'no_reply', 'reply']);
  });

  it('holds back only what reaches the customer, and a discount always waits for a person', () => {
    const draft = TEAMMATE_TOOLS.filter((t) => t.autonomy === 'draft').map((t) => t.name);
    expect(draft).toEqual([
      'book',
      'reschedule',
      'book_repeating',
      'join_waitlist',
      'add_to_appointment',
      'cancel',
      'reply',
    ]);
    expect(TEAMMATE_TOOLS.filter((t) => t.autonomy === 'approval').map((t) => t.name)).toEqual([
      'offer_discount',
      'send_payment_link',
      'propose_bill',
      'send_quote',
      'propose_quote',
      'record_quote_answer',
      'offer_plan',
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
      'read_call_transcript',
      'job_status',
      'update_customer',
      'add_note',
      'create_task',
      'note_photos',
      'hand_off',
      'reply',
      'no_reply',
    ]);
    expect(names(coordinator)).toEqual([
      'search_knowledge',
      'read_call_transcript',
      'find_times',
      'check_service_area',
      'my_appointments',
      'job_status',
      'book',
      'reschedule',
      'join_waitlist',
      'add_to_appointment',
      'cancel',
      'update_customer',
      'add_note',
      'create_task',
      'note_photos',
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

  it('turns on the deal tools with Deals, never for an unverified chat visitor (M18)', () => {
    const deals = ['open_deal', 'set_deal_value', 'close_deal'];
    for (const t of deals) expect(names(responder)).not.toContain(t);
    const on = applyTeammatePatch(responder, { deals: { enabled: true } });
    expect(names(on)).toEqual(expect.arrayContaining(deals));
    for (const t of deals) expect(names(on, true)).not.toContain(t);
  });

  it('turns on the money tools with their switches, never for an unverified chat visitor (M18)', () => {
    const money = (patch: TeammatePatch['money']) =>
      names(applyTeammatePatch(responder, { money: patch }));
    expect(money({ bills: true })).toEqual(
      expect.arrayContaining(['my_bills', 'send_payment_link']),
    );
    expect(money({ newBills: true })).toContain('propose_bill');
    expect(money({ quotes: 'send_only' })).not.toContain('propose_quote');
    expect(money({ quotes: 'send_only' })).toEqual(
      expect.arrayContaining(['my_quotes', 'send_quote', 'record_quote_answer']),
    );
    expect(money({ quotes: 'build' })).toContain('propose_quote');
    expect(money({ plans: true })).toContain('offer_plan');
    const all = applyTeammatePatch(responder, {
      money: { bills: true, newBills: true, quotes: 'build', plans: true },
    });
    for (const t of ['my_bills', 'propose_bill', 'my_quotes', 'offer_plan'])
      expect(names(all, true)).not.toContain(t);
  });

  it('follows the waitlist, repeats and service area switches (M18)', () => {
    expect(names(coordinator)).not.toContain('book_repeating');
    const all = applyTeammatePatch(coordinator, { book: { repeats: true } });
    expect(names(all)).toEqual(
      expect.arrayContaining(['book_repeating', 'join_waitlist', 'check_service_area']),
    );
    const none = applyTeammatePatch(all, {
      book: { repeats: false, waitlist: false, serviceArea: false },
    });
    for (const t of ['book_repeating', 'join_waitlist', 'check_service_area'])
      expect(names(none)).not.toContain(t);
  });

  it('hides a matched customer’s bookings and details from an unverified chat visitor', () => {
    expect(names(coordinator, true)).toEqual([
      'search_knowledge',
      'find_times',
      'check_service_area',
      'book',
      'join_waitlist',
      'add_note',
      'create_task',
      'send_verification_code',
      'check_verification_code',
      'note_photos',
      'hand_off',
      'reply',
      'no_reply',
    ]);
    for (const hidden of UNVERIFIED_CHAT_HIDDEN)
      expect(names(coordinator, true)).not.toContain(hidden);
  });

  it('offers note_photos while the teammate looks at photos (M18)', () => {
    expect(names(coordinator)).toContain('note_photos');
    expect(names(applyTeammatePatch(coordinator, { photos: { enabled: false } }))).not.toContain(
      'note_photos',
    );
  });

  it('offers the chat code tools only to an unverified chat visitor', () => {
    for (const only of UNVERIFIED_CHAT_ONLY) {
      expect(names(coordinator, true)).toContain(only);
      expect(names(coordinator)).not.toContain(only);
    }
  });

  it('writes nothing for a customer on file whose number an unverified chat visitor typed', () => {
    const qualifier = teammateConfigFromPreset('lead_qualifier', presetContext);
    const stranger = teammateTools(qualifier, { unverifiedChat: true, strangerInChat: true }).map(
      (t) => t.name,
    );
    for (const hidden of STRANGER_IN_CHAT_HIDDEN) {
      expect(stranger).not.toContain(hidden);
      // A visitor the chat added itself is still qualified and noted.
      expect(names(qualifier, true)).toContain(hidden);
    }
    // Proving who they are is how they get it back.
    expect(stranger).toContain('send_verification_code');
  });

  it('always lets it end its turn: end_call on a phone call, no_reply everywhere else', () => {
    const bare = applyTeammatePatch(responder, {
      respond: { enabled: false },
      answer: { enabled: false },
    });
    expect(names(bare)).toEqual(expect.arrayContaining(['hand_off', 'reply', 'no_reply']));
    expect(names(bare)).not.toContain('end_call');
    const onCall = teammateTools(bare, { phone: true }).map((t) => t.name);
    expect(onCall).toEqual(expect.arrayContaining(['hand_off', 'reply', 'end_call']));
    expect(onCall).not.toContain('no_reply');
  });

  it('on a phone call: no photos and no chat codes (M18 step 5)', () => {
    const all = applyTeammatePatch(responder, { photos: { enabled: true } });
    const onCall = teammateTools(all, { phone: true }).map((t) => t.name);
    expect(names(all)).toContain('note_photos');
    for (const hidden of ['note_photos', 'send_verification_code', 'check_verification_code'])
      expect(onCall).not.toContain(hidden);
  });
});
