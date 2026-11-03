/**
 * The AI's part in who to follow up with after a webinar (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, parts 4 and 5),
 * without a model or a database: what it's asked, and how its answers are cleaned up before the editor or the ranked
 * list sees them.
 *
 * What's worth holding:
 *   - a drafted question keeps its kind's limits, a slide the PDF has, and points only under keys the editor knows;
 *   - a button always has words, and the lines always leave Warm below Hot;
 *   - the model reads what each person did and how long they stayed, never their points.
 */
import { describe, expect, it } from 'vitest';
import {
  cleanDraft,
  draftRequest,
  PollDraftInput,
  PollPointsInput,
  pointsRequest,
  saneLines,
} from '../src/forms/poll-draft-routes';
import { leadLine } from '../src/video-calls/leads';

const WS = '6f1d2c3b-4a59-4e8f-9a0b-1c2d3e4f5a6b';

describe('a drafted question', () => {
  it('keeps a choice’s points by its number, and only for choices it has', () => {
    expect(
      cleanDraft(
        {
          type: 'choice',
          title: 'How do you get leads?',
          choices: ['Referrals', 'Ads', 'Referrals'],
          cues: ['where do leads come from', 'where do leads come from'],
          slide: 3,
          points: [
            { key: '2', points: 12 },
            { key: '3', points: 9 },
            { key: '1', points: 0 },
          ],
        },
        6,
      ),
    ).toEqual({
      type: 'choice',
      title: 'How do you get leads?',
      choices: ['Referrals', 'Ads'],
      cues: ['where do leads come from'],
      slide: 3,
      points: { '2': 12 },
    });
  });

  it('keeps points small and under the keys its kind has', () => {
    const scale = cleanDraft(
      {
        type: 'scale',
        title: 'How ready are you?',
        choices: ['ignored'],
        cues: [],
        slide: null,
        points: [
          { key: '10', points: 250 },
          { key: '9', points: 14.6 },
          { key: '11', points: 5 },
          { key: 'yes', points: 5 },
        ],
      },
      0,
    );
    expect(scale.choices).toEqual([]);
    expect(scale.points).toEqual({ '10': 100, '9': 15 });
    const yesNo = cleanDraft(
      {
        type: 'yes_no',
        title: 'Do you use a CRM?',
        choices: [],
        cues: [],
        slide: null,
        points: [
          { key: 'yes', points: 10 },
          { key: 'no', points: -30 },
          { key: 'pressed', points: 5 },
        ],
      },
      0,
    );
    expect(yesNo.points).toEqual({ yes: 10, no: -30 });
  });

  it('drops a slide the PDF doesn’t have, and gives a button words', () => {
    const button = cleanDraft(
      {
        type: 'button',
        title: 'Want help setting it up?',
        choices: [],
        cues: [],
        slide: 9,
        points: [{ key: 'pressed', points: 25 }],
      },
      6,
    );
    expect(button).toMatchObject({
      choices: ['Talk to someone'],
      slide: null,
      points: { pressed: 25 },
    });
    expect(
      cleanDraft(
        {
          type: 'button',
          title: 'Ready?',
          choices: ['Book my free setup call today, please and thank you', 'Other'],
          cues: [],
          slide: 0,
          points: [],
        },
        6,
      ),
    ).toMatchObject({ choices: ['Book my free setup call today, please an'], slide: null });
  });
});

describe('the lines', () => {
  it('keeps Warm below Hot, and both where the editor takes them', () => {
    expect(saneLines({ stayed: 10, hot: 30, warm: 10 })).toEqual({ stayed: 10, hot: 30, warm: 10 });
    expect(saneLines({ stayed: 500, hot: 20, warm: 40 })).toEqual({
      stayed: 100,
      hot: 20,
      warm: 19,
    });
    expect(saneLines({ stayed: -5, hot: 0, warm: -3 })).toEqual({ stayed: 0, hot: 1, warm: 0 });
  });
});

describe('what the model is asked', () => {
  it('lists each question’s answers by key for points', () => {
    const asked = pointsRequest(
      PollPointsInput.parse({
        workspaceId: WS,
        title: 'Roofing webinar',
        goal: 'Book demos',
        questions: [
          {
            id: 'q_crm00000',
            type: 'yes_no',
            title: 'Do you use a CRM?',
            answers: [
              { key: 'yes', label: 'Yes' },
              { key: 'no', label: 'No' },
            ],
          },
        ],
      }),
    );
    expect(asked).toBe(
      [
        'The poll: Roofing webinar',
        'What the webinar is for: Book demos',
        '- q_crm00000 (yes_no): Do you use a CRM? · answers: yes = Yes; no = No',
        'Suggest the points for every answer.',
      ].join('\n'),
    );
  });

  it('says what the webinar is for and how many to draft, with the slides when there are some', () => {
    const input = PollDraftInput.parse({ workspaceId: WS, goal: '  Get roofers to book a demo ' });
    expect(input.count).toBe(6);
    const plain = draftRequest(input, null);
    expect(plain).toContain('What the webinar is for: Get roofers to book a demo');
    expect(plain).toContain('How many questions and buttons: 6');
    expect(draftRequest(input, ['Welcome', 'Pricing'])).toContain('Slide 2: Pricing');
    expect(plain.endsWith('Draft the poll.')).toBe(true);
    expect(PollDraftInput.safeParse({ workspaceId: WS, goal: '   ' }).success).toBe(false);
  });

  it('tells the model what each person did and how long they stayed, never their points', () => {
    const line = leadLine(
      {
        id: 'lead-1',
        label: 'hot',
        points: 55,
        stayed: false,
        seconds: 1500,
        parts: [
          { what: '“Do you use a CRM?”: Yes', points: 15 },
          { what: 'Pressed “Talk to someone”', points: 20 },
        ],
        first_name: 'Ann',
      },
      60,
    );
    expect(line).toBe(
      '- lead-1 (hot): “Do you use a CRM?”: Yes; Pressed “Talk to someone”; stayed 25 of 60 minutes',
    );
    expect(line).not.toContain('55');
    expect(
      leadLine(
        {
          id: 'lead-2',
          label: 'cold',
          points: 10,
          stayed: true,
          seconds: 3600,
          parts: [{ what: 'Stayed to the end', points: 10 }],
          first_name: null,
        },
        null,
      ),
    ).toBe('- lead-2 (cold): stayed to the end');
  });
});
