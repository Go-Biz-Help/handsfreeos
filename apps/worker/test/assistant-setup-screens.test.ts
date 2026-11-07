import {
  AiSetupAnswers,
  AssistantCard,
  OnboardingSetupAnswers,
  QUESTION_WORDS,
  stepTitle,
} from '@hfos/core/server';
import { describe, expect, it } from 'vitest';
import {
  changedAnswers,
  gettingStartedRead,
  mergedAnswers,
  setupCard,
  setupOutcome,
} from '../src/assistant/setup-screens';
import { allScreenActionTools } from '../src/assistant/tools-screen-actions';

/**
 * The guided setup and Getting started for the Assistant, without a database: a save goes over the answers kept,
 * its card says what would change, and Getting started reads as Home's card shows it. The rest runs against the
 * database in assistant-wizards.test.ts and assistant-screen-reads.test.ts.
 */

const tool = (command: string) => {
  const found = allScreenActionTools().find((t) => t.command.name === command);
  if (!found) throw new Error(`No screen action for ${command}`);
  return found;
};
const WS = '7d0c5f4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f';
const CALL = '5b8f2c1e-3d4a-4b6c-9e7f-1a2b3c4d5e6f';

const saved = OnboardingSetupAnswers.parse({
  goal: 'booked',
  usePage: false,
  reviewLink: 'https://g.page/r/lone-star/review',
  ai: { name: 'Sam', description: 'We fix air conditioners.' },
});

describe('the guided setup’s saves, as the Assistant makes them', () => {
  it('keeps every answer the model leaves out, the AI teammate’s one by one', () => {
    const merged = mergedAnswers(saved, { goal: 'paid', ai: { allowPrices: true } }, true);
    const read = OnboardingSetupAnswers.parse(merged);
    expect(read.goal).toBe('paid');
    expect(read.usePage).toBe(false);
    expect(read.reviewLink).toBe('https://g.page/r/lone-star/review');
    expect(read.ai.name).toBe('Sam');
    expect(read.ai.description).toBe('We fix air conditioners.');
    expect(read.ai.allowPrices).toBe(true);
    expect(changedAnswers(saved, merged, true)).toEqual([
      ['goal', 'paid'],
      ['ai.allowPrices', true],
    ]);
    // Nothing given: everything as it was kept.
    expect(mergedAnswers(saved, undefined, true)).toBe(saved);
    expect(changedAnswers(saved, mergedAnswers(saved, {}, true), true)).toEqual([]);
  });

  it('keeps quick setup’s other answers too, where they aren’t under ai', () => {
    const kept = AiSetupAnswers.parse({ name: 'Sam', tone: 'professional', allowPrices: true });
    const merged = AiSetupAnswers.parse(mergedAnswers(kept, { name: 'Max' }, false));
    expect(merged).toEqual({ ...kept, name: 'Max' });
  });

  it('never takes the page’s address from the model, and says to pass only what changes', () => {
    for (const command of ['onboarding_setup.finish', 'ai_setup.finish']) {
      const t = tool(command);
      expect(Object.keys(t.input.shape), command).not.toContain('pageOrigin');
      expect(t.description, command).toContain('Pass only the answers this screen changes');
    }
    // The guided setup keeps the AI teammate's answers under ai; quick setup's are the teammate's own.
    for (const command of ['onboarding_setup.save', 'onboarding_setup.finish'])
      expect(tool(command).description, command).toContain('answers.ai');
    for (const command of ['ai_setup.save', 'ai_setup.finish'])
      expect(tool(command).description, command).not.toContain('answers.ai');
    expect(tool('onboarding_setup.save').warning).toContain('Your goal sends its invitations');
  });

  it('draws the card from what saving would change, with what it couldn’t do', () => {
    const t = tool('onboarding_setup.save');
    const answers = mergedAnswers(saved, { goal: 'paid', reviewLink: '' }, true);
    const drawn = setupCard(
      CALL,
      t,
      { input: { workspaceId: WS, screen: 'paid', answers, invite: [] }, saved },
      {
        changes: ['Takes away your review link'],
        notes: ['Square couldn’t be checked just now. Try again in a minute.'],
      },
    );
    const card = drawn.card!;
    expect(AssistantCard.safeParse(card).success).toBe(true);
    expect(card.type).toBe('confirm');
    if (card.type !== 'confirm') return;
    expect(card.title).toBe('Save “Payments and reviews”?');
    expect(card.fields).toContainEqual({ label: 'Screen', value: 'Payments and reviews' });
    expect(card.fields).toContainEqual({
      label: QUESTION_WORDS.goal,
      value: QUESTION_WORDS.goals.paid,
    });
    expect(card.fields).toContainEqual({ label: 'Review link', value: 'None' });
    expect(card.body).toContain('• Takes away your review link');
    expect(card.warnings.map((w) => w.kind)).toEqual(['caution', 'note']);
    expect(drawn.result).toMatchObject({
      waiting: true,
      answersChanged: ['goal', 'reviewLink'],
      willChange: ['Takes away your review link'],
    });
  });

  it('says when a save changes nothing in the business yet', () => {
    const drawn = setupCard(
      CALL,
      tool('onboarding_setup.save'),
      { input: { workspaceId: WS, screen: 'goal', answers: saved, invite: [] }, saved },
      { changes: [], notes: [] },
    );
    const card = drawn.card!;
    if (card.type !== 'confirm') throw new Error('Not a confirm card');
    expect(card.fields).toContainEqual({ label: 'Screen', value: 'Your goal' });
    expect(card.body).toContain('Nothing else in the business changes yet');
  });

  it('says who it’s handed to when the agency hands it over', () => {
    const drawn = setupCard(
      CALL,
      tool('onboarding_setup.finish'),
      {
        input: { workspaceId: WS, answers: saved, baseRevision: null, owner: { email: null } },
        saved,
      },
      { changes: ['Turns the website chat on'], notes: [] },
    );
    const card = drawn.card!;
    if (card.type !== 'confirm') throw new Error('Not a confirm card');
    expect(card.title).toBe('Save it and hand it to the owner?');
    expect(card.confirmLabel).toBe('Hand it over');
    expect(card.fields).toContainEqual({
      label: 'Hand it to',
      value: 'Nobody yet: invite the owner later from Members',
    });
    expect(card.fields.map((f) => f.label)).not.toContain('Joins as');

    // With their email, it says what they join as, as the hand-over screen does.
    const named = setupCard(
      CALL,
      tool('onboarding_setup.finish'),
      {
        input: {
          workspaceId: WS,
          answers: saved,
          baseRevision: null,
          owner: { email: 'pat@hfos.test' },
        },
        saved,
        handOverAs: 'admin',
      },
      { changes: [], notes: [] },
    );
    if (named.card?.type !== 'confirm') throw new Error('Not a confirm card');
    expect(named.card.fields).toContainEqual({ label: 'Hand it to', value: 'pat@hfos.test' });
    expect(named.card.fields).toContainEqual({
      label: 'Joins as',
      value: 'An admin, since only an owner of your agency can make someone an owner',
    });
    expect(named.result).toMatchObject({ ownerJoinsAs: 'admin' });
  });

  it('says what changed and what it couldn’t do once saved', () => {
    expect(
      setupOutcome({
        changes: ['Invites sam@hfos.test to the team'],
        notes: ['Pat is already in this business.'],
      }),
    ).toBe('Saved. Invites sam@hfos.test to the team. Pat is already in this business.');
    expect(
      setupOutcome({ changes: [], notes: [], handedOver: { email: null, role: 'admin' } }),
    ).toBe('Saved, and handed to the owner.');
  });
});

describe('Getting started, as the Assistant reads it', () => {
  it('gives each step its title, line, button and where the button goes', () => {
    const step = (key: string, group: string, state = 'todo') => ({
      key,
      group,
      mustDo: group === 'basics',
      state,
      since: null,
      note: {},
    });
    const read = gettingStartedRead({
      workspaceId: WS,
      audience: 'business',
      enabled: true,
      answers: null,
      steps: [step('team', 'basics'), step('number', 'basics'), step('app', 'later')],
      next: 'team',
    }) as {
      next: unknown;
      steps: { key: string; title: string; button?: string; goesTo?: string; line: string }[];
    };
    expect(read.next).toEqual({ key: 'team', title: stepTitle('team') });
    const [team, number, app] = read.steps;
    expect(team).toMatchObject({ title: 'Invite your team', goesTo: 'Members' });
    expect(team!.line).toBeTruthy();
    expect(team!.button).toBeTruthy();
    expect(number!.goesTo).toBe('Its own setup step, which its button opens');
    expect(app!.goesTo).toBe('The phone app');
  });
});
