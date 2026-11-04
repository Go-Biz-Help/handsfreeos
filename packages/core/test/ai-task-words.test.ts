/**
 * "Add tasks from what you say": the words an AI-made task carries, and the labels a call's review shows, which the
 * web, the phone and the demo player all read from here.
 */
import { describe, expect, it } from 'vitest';
import {
  aiTaskFromLine,
  aiTaskNotes,
  aiTaskSourceOf,
  AUTOMATIONS,
  automationSettingsOf,
  callReviewLabel,
} from '../src/automations/index';

describe('where an AI-made task came from', () => {
  it('names the call or the message, and who it was with', () => {
    expect(aiTaskFromLine('phone_call', 'Mike Johnson')).toBe(
      'Added by the AI from your call with Mike Johnson.',
    );
    expect(aiTaskFromLine('video_call', null)).toBe('Added by the AI from your video call.');
    expect(aiTaskFromLine('sms', 'Ned Test')).toBe('Added by the AI from your text to Ned Test.');
    expect(aiTaskFromLine('chat', ' Ana ')).toBe(
      'Added by the AI from your website chat with Ana.',
    );
    expect(aiTaskFromLine(null, 'Ana')).toBe('Added by the AI from your message to Ana.');
  });

  it('reads a message’s channel, and never a call’s', () => {
    expect(aiTaskSourceOf('email')).toBe('email');
    expect(aiTaskSourceOf('messenger')).toBe('messenger');
    expect(aiTaskSourceOf('phone_call')).toBeNull();
    expect(aiTaskSourceOf('whatsapp')).toBeNull();
  });

  it('puts what the AI noted first, then where it came from', () => {
    expect(aiTaskNotes('  Two units, upstairs and down. ', 'email', 'Rosa Diaz')).toBe(
      'Two units, upstairs and down.\n\nAdded by the AI from your email to Rosa Diaz.',
    );
    expect(aiTaskNotes(null, 'sms', null)).toBe('Added by the AI from your text.');
  });
});

describe('a call’s review', () => {
  it('says a task the AI made is added, and the rest are suggested until someone decides', () => {
    expect(callReviewLabel('task', 'approved')).toBe('Task added');
    expect(callReviewLabel('task', 'pending')).toBe('Suggested task');
    expect(callReviewLabel('task', 'dismissed')).toBe('Suggested task · Dismissed');
    expect(callReviewLabel('follow_up', 'approved')).toBe('Suggested follow-up email · Done');
    expect(callReviewLabel('record_change', 'pending')).toBe('Suggested update to their record');
  });
});

describe('the switch', () => {
  it('is on unless a business turns it off, in Settings → Automations', () => {
    expect(automationSettingsOf(null).switches.aiTasks).toBe(true);
    expect(
      automationSettingsOf({ automations: { switches: { aiTasks: false } } }).switches.aiTasks,
    ).toBe(false);
    expect(AUTOMATIONS.find((a) => a.id === 'ai_tasks')).toMatchObject({
      label: 'Add tasks from what you say',
      defaultOn: true,
      binding: { store: 'automations', key: 'aiTasks' },
    });
  });
});
