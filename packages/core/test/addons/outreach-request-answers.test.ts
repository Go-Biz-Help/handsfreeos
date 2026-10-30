/**
 * The AI deciding the friend requests the person gets (docs/outreach.md, decision 136): what it's asked of someone who
 * sent one, what it may answer, and how its answer, the person's own press and their pick in Settings come to Confirm,
 * Delete or theirs to decide, on Facebook, LinkedIn and Alignable.
 */
import { describe, expect, it } from 'vitest';
import { answersRequests } from '../../src/addons/outreach/networks';
import {
  autoKinds,
  AUTOMATION_DEFAULTS,
  readsRequests,
  requestAnswerOf,
  REQUEST_MODE_KEYS,
} from '../../src/addons/outreach/automation';
import {
  checkedAnswer,
  CHECK_ASK,
  reachesWords,
  RequestCheckAnswer,
  REQUEST_CHECK_ASK,
  REQUEST_CHECK_SCHEMA,
  requestCheckPrompt,
  requestCheckSystem,
  REQUEST_MUTUAL_YES,
} from '../../src/addons/outreach/checks';
import { requestsChoiceOn } from '../../src/addons/outreach/network-words';

const someone = {
  business: 'Lane Landscaping',
  name: 'Frank Sinclair',
  facts: ['Lives in Austin, Texas'],
  lines: ['Owner at Sinclair Roofing'],
  chat: null,
  playbooks: [
    { name: 'Homeowners', offer: 'Lawn care', audience: 'Homeowners', signs: [], skip: [] },
  ],
};

describe('the request check', () => {
  it('asks what to do with the request, with the mutual friends and where the business reaches', () => {
    const prompt = requestCheckPrompt({
      ...someone,
      mutualFriends: 58,
      reaches: reachesWords({ mode: 'only', codes: ['US'], unsure: 'ask' }),
    });
    expect(prompt).toContain(
      '<request>Sent the owner a friend request on Facebook, with 58 mutual friends.</request>',
    );
    expect(prompt).toContain('<reaches>Only people who live in United States</reaches>');
    expect(prompt.endsWith(REQUEST_CHECK_ASK)).toBe(true);
    expect(prompt).not.toContain(CHECK_ASK);
    // On LinkedIn, in its words.
    const linkedin = requestCheckPrompt({
      ...someone,
      platform: 'linkedin',
      mutualFriends: 1,
      reaches: reachesWords({ mode: 'anywhere', codes: [], unsure: 'ask' }),
    });
    expect(linkedin).toContain('LinkedIn');
    expect(linkedin).toContain('1 mutual connection');
    expect(linkedin).toContain('<reaches>Anywhere</reaches>');
    expect(requestCheckSystem('linkedin')).not.toContain('Facebook');
    expect(requestCheckSystem()).toContain(`${REQUEST_MUTUAL_YES} or more mutual friends`);
  });

  it('says where the business reaches in full', () => {
    expect(reachesWords({ mode: 'anywhere', codes: ['US'], unsure: 'ask' })).toBe('Anywhere');
    expect(reachesWords({ mode: 'not', codes: ['GB', 'CA'], unsure: 'ask' })).toBe(
      'Anyone but people who live in United Kingdom, Canada',
    );
  });

  it('answers the usual read and what to do with the request, in one line of why', () => {
    expect(REQUEST_CHECK_SCHEMA.required).toEqual(
      expect.arrayContaining(['fit', 'answer', 'answerWhy']),
    );
    const answer = RequestCheckAnswer.parse({
      fit: 'good',
      playbook: 'homeowners',
      why: ['Owns a home in Austin'],
      about: 'Owns a roofing company',
      nextStep: null,
      answer: 'confirm',
      answerWhy: `  Owns a roofing company\nin Austin  `,
    });
    const checked = checkedAnswer(answer, [{ id: 'p1', name: 'Homeowners' }]);
    expect(checked.request).toEqual({ answer: 'confirm', why: 'Owns a roofing company in Austin' });
    expect(checked.playbookId).toBe('p1');
    // A friend's check has no request answer.
    expect(checkedAnswer({ ...answer, answer: undefined }, []).request).toBeNull();
    expect(() => RequestCheckAnswer.parse({ ...answer, answer: 'maybe' })).toThrow();
  });
});

describe('what comes of a request', () => {
  const base = {
    pressed: null,
    pitched: true,
    playbooks: true,
    said: null,
    good: false,
  } as const;

  it('does the person’s own Confirm or Delete first, whatever they picked', () => {
    for (const mode of REQUEST_MODE_KEYS) {
      expect(requestAnswerOf({ ...base, mode, pressed: 'confirm', said: 'delete' })).toBe(
        'confirm',
      );
      expect(requestAnswerOf({ ...base, mode, pressed: 'delete', pitched: false })).toBe('delete');
    }
  });

  it('confirms the AI’s yes, and deletes its no only when they picked that, with a playbook in use', () => {
    expect(requestAnswerOf({ ...base, mode: 'fits', said: 'confirm' })).toBe('confirm');
    expect(requestAnswerOf({ ...base, mode: 'fits', said: 'delete' })).toBeNull();
    expect(requestAnswerOf({ ...base, mode: 'fits_delete', said: 'delete' })).toBe('delete');
    expect(
      requestAnswerOf({ ...base, mode: 'fits_delete', said: 'delete', playbooks: false }),
    ).toBeNull();
    expect(requestAnswerOf({ ...base, mode: 'fits_delete', said: 'ask' })).toBeNull();
    // Not read yet: a keyword fit with a playbook in use still confirms, as before.
    expect(requestAnswerOf({ ...base, mode: 'fits', good: true })).toBe('confirm');
    expect(requestAnswerOf({ ...base, mode: 'fits', good: true, playbooks: false })).toBeNull();
  });

  it('leaves them all to the person, or answers them all one way, without the AI', () => {
    expect(requestAnswerOf({ ...base, mode: 'mine', said: 'confirm' })).toBeNull();
    expect(requestAnswerOf({ ...base, mode: 'all' })).toBe('confirm');
    expect(requestAnswerOf({ ...base, mode: 'delete' })).toBe('delete');
    // Someone on Don't pitch is never answered but by their own press.
    expect(requestAnswerOf({ ...base, mode: 'all', pitched: false })).toBeNull();
    expect(readsRequests('all')).toBe(false);
    expect(readsRequests('delete')).toBe(false);
    expect(readsRequests('fits')).toBe(true);
    expect(readsRequests('mine')).toBe(true);
  });

  it('answers them on Facebook, LinkedIn and Alignable, and confirms there on its own', () => {
    expect(answersRequests('facebook')).toBe(true);
    expect(answersRequests('linkedin')).toBe(true);
    expect(answersRequests('alignable')).toBe(true);
    expect(answersRequests('instagram')).toBe(false);
    const doing = { ...AUTOMATION_DEFAULTS, sending: 'steps' as const };
    for (const platform of ['linkedin', 'alignable'] as const) {
      expect(autoKinds(doing, platform)).toContain('confirm');
      expect(requestsChoiceOn(platform)?.about).toContain('mutual connections');
    }
    expect(requestsChoiceOn('instagram')).toBeNull();
  });
});
