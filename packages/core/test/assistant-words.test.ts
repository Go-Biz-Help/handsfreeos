import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_OPTIONS,
  ASSISTANT_WORDS,
  assistantCancelledText,
  assistantChatWhen,
  assistantConsentWords,
  assistantMoneyOpenLabel,
  assistantMoveKind,
  assistantNotice,
  assistantNoticeAction,
  assistantOpenLabel,
  assistantPageRecord,
  assistantStageKind,
  assistantWarningTone,
  deleteBlockedLine,
  handsOverLine,
  joinNames,
  keptBusinessesLine,
  onlyOwnerLine,
  type ConfirmCard,
} from '../src/index';

/**
 * The Assistant's words and the settings words, shared by the web's panel and the phone's Ask HandsFreeOS screen
 * (M10 step 17). The wording itself is the contract: both apps read these, so a change here is a change on both.
 */

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const confirm = (over: Partial<ConfirmCard> = {}): ConfirmCard => ({
  type: 'confirm',
  toolCallId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  tool: 'send_text',
  personId: null,
  conversationId: null,
  title: 'Text Mike Johnson',
  fields: [{ label: 'To', value: 'Mike Johnson · (713) 555-0142' }],
  body: 'Hi Mike…',
  stageFrom: null,
  stageTo: null,
  warnings: [],
  reasons: [],
  confirmLabel: 'Send text',
  editable: true,
  ...over,
});

describe('the notice cards', () => {
  it('names the business in the day’s limit, and says what still works', () => {
    const notice = assistantNotice('budget_reached', {
      workspaceName: 'Lone Star HVAC',
      message: 'ignored',
    })!;
    expect(notice.title).toBe('That’s today’s Assistant limit for Lone Star HVAC');
    expect(notice.sub).toBe('It resets at midnight. Everything else in HandsFreeOS still works.');
    expect(notice.tone).toBe('warning');
    expect(assistantNoticeAction(notice)).toBe(null);
  });

  it('offers Try again where trying again can work, and Reload where the answer is saved', () => {
    const args = { workspaceName: 'Lone Star HVAC', message: 'The worker said so.' };
    expect(assistantNoticeAction(assistantNotice('busy', args)!)).toBe('Try again');
    expect(assistantNoticeAction(assistantNotice('unreachable', args)!)).toBe('Try again');
    expect(assistantNoticeAction(assistantNotice('already_running', args)!)).toBe('Try again');
    expect(assistantNoticeAction(assistantNotice('failed', args)!)).toBe('Try again');
    expect(assistantNoticeAction(assistantNotice('dropped', args)!)).toBe('Reload the chat');
    expect(assistantNotice('dropped', args)!.sub).toBe(
      'The answer is saved in this chat when it finishes.',
    );
  });

  it('falls back to the worker’s own words where the card has none, and Stop has no card', () => {
    const notice = assistantNotice('forbidden', {
      workspaceName: 'Lone Star HVAC',
      message: 'You need permission to use the Assistant.',
    })!;
    expect(notice.sub).toBe('You need permission to use the Assistant.');
    expect(notice.action).toBe(null);
    expect(assistantNotice('stopped', { workspaceName: 'Lone Star HVAC', message: '' })).toBe(null);
  });
});

describe('the consent step', () => {
  it('says what is sent, that nothing reaches a customer without an OK, and where the OK is kept', () => {
    const web = assistantConsentWords('web');
    expect(web.title).toBe('The Assistant uses Anthropic’s Claude');
    expect(web.lead).toBe('What you ask about is sent to Anthropic’s Claude to answer you.');
    // The processor is named on purpose: it is what makes the consent informed.
    expect(web.footnote).toBe('Anthropic is the company that makes Claude.');
    expect(web.points[1]!.text).toBe(
      'Nothing goes to a customer, and nothing is booked or changed, until you say OK.',
    );
    expect(web.points[2]!.text).toContain('again here or on your phone');
    expect(assistantConsentWords('phone').points[2]!.text).toContain(
      'again on your phone or on the web',
    );
    expect(web.ok).toBe('OK, continue');
    expect(web.notNow).toBe('Not now');
  });
});

describe('a confirmation once it is answered', () => {
  it('says who a cancelled text did not reach, by their first name', () => {
    expect(assistantCancelledText(confirm())).toBe('Not sent. Nothing went to Mike.');
    expect(assistantCancelledText(confirm({ fields: [] }))).toBe('Not sent.');
    expect(assistantCancelledText(confirm({ tool: 'send_email' }))).toBe(
      'Not sent. Nothing went to Mike.',
    );
  });

  it('says where a lead stays, and reads a lost move from its reasons or its words', () => {
    const move = confirm({
      tool: 'move_lead',
      title: 'Move AC install to Quoted?',
      stageFrom: 'New',
      stageTo: 'Quoted',
      confirmLabel: 'Move lead',
      fields: [],
    });
    expect(assistantCancelledText(move)).toBe('Not moved. It stays in New.');
    expect(assistantMoveKind(move)).toBe('open');
    const lost = { ...move, title: 'Mark AC install as lost?', reasons: ['Price'] };
    expect(assistantCancelledText(lost)).toBe('Not changed. It stays in New.');
    expect(assistantMoveKind(lost)).toBe('lost');
    expect(assistantMoveKind({ ...move, title: 'Mark AC install as won?' })).toBe('won');
    expect(assistantStageKind('Won')).toBe('won');
    expect(assistantStageKind('Quoted')).toBe('open');
  });

  it('words every other tool’s no in its own terms', () => {
    const say = (tool: string, over: Partial<ConfirmCard> = {}) =>
      assistantCancelledText(confirm({ tool, fields: [], ...over }));
    expect(say('book_appointment')).toBe('Not booked. Nothing was added to the calendar.');
    expect(say('cancel_appointment')).toBe('Kept. The appointment is still on.');
    expect(
      say('reschedule_appointment', { fields: [{ label: 'Was', value: 'Fri at 10:00 AM' }] }),
    ).toBe('Not moved. It stays Fri at 10:00 AM.');
    expect(say('reschedule_appointment')).toBe('Not moved.');
    expect(say('create_customer')).toBe('Nothing added.');
    expect(say('create_lead')).toBe('No lead opened.');
    expect(say('start_workflow')).toBe('Not started. Nothing was sent.');
    expect(say('pause_workflow')).toBe('Not paused. It’s still on.');
    expect(say('resume_workflow')).toBe('Still paused.');
    expect(say('remove_contact_from_workflow')).toBe('Left in. Nothing stopped.');
    expect(say('answer_workflow_approval')).toBe(
      'Not answered. It’s still waiting for a decision.',
    );
    expect(say('handle_attention_item')).toBe('Not handled. It’s still on Home.');
    expect(say('update_attention_item', { confirmLabel: 'Snooze' })).toBe(
      'Not snoozed. It’s still on Home.',
    );
    expect(say('update_attention_item', { confirmLabel: 'Dismiss' })).toBe(
      'Not dismissed. It’s still on Home.',
    );
    expect(say('something_new')).toBe('Not changed.');
  });

  it('opens where the result landed', () => {
    expect(assistantOpenLabel('send_text', `/app/w/${WS}/inbox/x`)).toBe('Open conversation');
    expect(assistantOpenLabel('create_customer', `/app/w/${WS}/customers/people/x`)).toBe(
      'Open customer',
    );
    expect(assistantOpenLabel('move_lead', `/app/w/${WS}/leads/x`)).toBe('Open lead');
    expect(assistantOpenLabel('start_workflow', `/app/w/${WS}/workflows/runs`)).toBe('See runs');
    expect(assistantOpenLabel('handle_attention_item', `/app/w/${WS}/inbox/x`)).toBe(
      'Open conversation',
    );
    expect(assistantOpenLabel('handle_attention_item', `/app/w/${WS}/leads/x`)).toBe('Open lead');
    expect(assistantOpenLabel('handle_attention_item', `/app/w/${WS}`)).toBe('Open Home');
    expect(assistantOpenLabel('whatever', `/app/w/${WS}`)).toBe('Open');
  });

  it('names the list a money card opens', () => {
    expect(assistantMoneyOpenLabel(`/app/w/${WS}/money`)).toBe('Open invoices');
    expect(assistantMoneyOpenLabel(`/app/w/${WS}/money/estimates`)).toBe('Open estimates');
    expect(assistantMoneyOpenLabel(`/app/w/${WS}/money/payments`)).toBe('Open payments');
    expect(assistantMoneyOpenLabel(`/app/w/${WS}/money/plans`)).toBe('Open plans');
    expect(assistantMoneyOpenLabel(`/app/w/${WS}/money/invoices/x`)).toBe('Open');
  });

  it('reads a warning’s tone: a caution, something to know, or a refusal', () => {
    expect(assistantWarningTone('quiet_hours')).toBe('warning');
    expect(assistantWarningTone('conflict')).toBe('warning');
    expect(assistantWarningTone('duplicate')).toBe('accent');
    expect(assistantWarningTone('note')).toBe('accent');
    expect(assistantWarningTone('blocked')).toBe('danger');
    expect(assistantWarningTone('something_new')).toBe('warning');
  });
});

describe('the record a question is asked from', () => {
  const ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  it('reads the customer, company, lead, conversation, workflow or appointment the page is showing', () => {
    const at = (rest: string, appt: string | null = null) =>
      assistantPageRecord(`/app/w/${WS}/${rest}`, WS, appt);
    expect(at(`customers/people/${ID}`)).toEqual({ type: 'person', id: ID });
    expect(at(`customers/companies/${ID}`)).toEqual({ type: 'company', id: ID });
    expect(at(`leads/${ID}`)).toEqual({ type: 'lead', id: ID });
    expect(at(`inbox/${ID}`)).toEqual({ type: 'conversation', id: ID });
    expect(at(`workflows/${ID}`)).toEqual({ type: 'workflow', id: ID });
    expect(at(`workflows/runs/${ID}`)).toEqual({ type: 'workflow_run', id: ID });
    expect(at('calendar', ID)).toEqual({ type: 'appointment', id: ID });
  });

  it('has no record for a list, another business’s page, or a name that isn’t an id', () => {
    expect(assistantPageRecord(`/app/w/${WS}/customers`, WS)).toBe(null);
    expect(assistantPageRecord(`/app/w/${WS}/calendar`, WS)).toBe(null);
    expect(assistantPageRecord(`/app/w/${WS}/inbox/not-an-id`, WS)).toBe(null);
    expect(assistantPageRecord(`/app/w/other/customers/people/${ID}`, WS)).toBe(null);
    expect(assistantPageRecord('/sign-in', WS)).toBe(null);
  });
});

describe('when a chat happened', () => {
  const now = new Date('2026-09-17T15:00:00');
  it('says Today with the time, then Yesterday and the date', () => {
    expect(assistantChatWhen('2026-09-17T08:28:00', {}, now)).toBe('Today, 8:28 AM');
    expect(assistantChatWhen('2026-09-16T08:28:00', {}, now)).toBe('Yesterday');
    expect(assistantChatWhen('2026-09-16T08:28:00', { time: true }, now)).toBe(
      'Yesterday, 8:28 AM',
    );
    expect(assistantChatWhen('2026-09-10T08:28:00', {}, now)).toBe('Sep 10');
    expect(assistantChatWhen('2025-09-10T08:28:00', {}, now)).toBe('Sep 10, 2025');
    expect(assistantChatWhen('not a date', {}, now)).toBe('');
  });
});

describe('the phone with no signal', () => {
  it('says the Assistant needs signal, and what still works without it', () => {
    expect(ASSISTANT_WORDS.offline.title).toBe('The Assistant needs signal');
    expect(ASSISTANT_WORDS.offline.body).toBe(
      'Your question is saved — ask again when you’re back online.',
    );
    expect(ASSISTANT_WORDS.offline.works).toContain('keep working with no signal');
  });
});

describe('the settings words', () => {
  it('offers light, dark and the device’s own setting, in that order', () => {
    expect(APPEARANCE_OPTIONS.map((o) => o.value)).toEqual(['light', 'dark', 'system']);
    expect(APPEARANCE_OPTIONS.map((o) => o.desc)).toEqual([
      'Always light',
      'Always dark',
      'Follows this device',
    ]);
  });

  it('says which businesses are on this phone', () => {
    expect(keptBusinessesLine([], 0)).toBe('None: every business opens only with signal');
    expect(keptBusinessesLine([{ name: 'Lone Star HVAC' }], 1)).toBe(
      'Getting one onto this phone…',
    );
    expect(keptBusinessesLine([{ name: 'A' }, { name: 'B' }, { name: 'C' }], 2)).toBe(
      'Getting 2 onto this phone…',
    );
    expect(keptBusinessesLine([{ name: 'Lone Star HVAC' }], 0)).toBe(
      'Lone Star HVAC · works with no signal',
    );
    expect(keptBusinessesLine([{ name: 'A' }, { name: 'B' }], 0)).toBe(
      '2 businesses · work with no signal',
    );
  });

  it('names the businesses that stand between someone and deleting their account', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B'])).toBe('A and B');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
    expect(deleteBlockedLine(['Lone Star HVAC'])).toBe(
      'Available once someone else owns Lone Star HVAC.',
    );
    expect(deleteBlockedLine(['A', 'B'])).toBe('Available once someone else owns each of A and B.');
    expect(handsOverLine('Lone Star HVAC', ['Dale Ramsey'])).toBe(
      'Lone Star HVAC stays with Dale Ramsey, its other owner.',
    );
    expect(handsOverLine('Lone Star HVAC', ['Dale', 'Marco'])).toBe(
      'Lone Star HVAC stays with Dale and Marco, its other owners.',
    );
    expect(onlyOwnerLine('Marco')).toBe(
      'Make Marco or someone else an owner first, so the business isn’t left without one.',
    );
    expect(onlyOwnerLine(null)).toBe(
      'Invite someone and make them an owner first, so the business isn’t left without one.',
    );
  });
});
