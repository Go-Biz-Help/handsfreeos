import { describe, expect, it } from 'vitest';
import {
  checkNudgeTemplate,
  DEFAULT_NUDGE_TEMPLATE,
  nudgePlaceholderProblem,
  renderNudge,
  type NudgeCheckContext,
  type NudgeProblemCode,
} from '../src/attention/index';

const ctx: NudgeCheckContext = {
  businessName: 'Lone Star HVAC',
  businessPhone: '(512) 555-0100',
  allowed: {
    domains: ['lonestarhvac.com'],
    urlPrefixes: [],
    phones: ['+15125550100'],
    emails: ['office@lonestarhvac.com'],
  },
};

const problemCodes = (template: string): NudgeProblemCode[] =>
  checkNudgeTemplate(template, ctx).problems.map((p) => p.code);
const messages = (template: string) =>
  checkNudgeTemplate(template, ctx).problems.map((p) => p.message);

describe('renderNudge', () => {
  it('fills the default message', () => {
    const r = renderNudge(DEFAULT_NUDGE_TEMPLATE, {
      firstName: 'Maria',
      senderName: 'Dale',
      businessName: 'Lone Star HVAC',
    });
    expect(r).toEqual({
      text: "Hi Maria, it's Dale at Lone Star HVAC. Just checking in: are you still looking for help? Reply here and we'll take it from there.",
      missing: [],
    });
  });

  it('falls back when a name is missing', () => {
    const r = renderNudge(DEFAULT_NUDGE_TEMPLATE, {
      firstName: '  ',
      senderName: null,
      businessName: 'Lone Star HVAC',
    });
    expect(r.text).toBe(
      "Hi there, it's the team at Lone Star HVAC. Just checking in: are you still looking for help? Reply here and we'll take it from there.",
    );
  });

  it('reports what it can’t fill, so the worker skips the nudge', () => {
    const r = renderNudge('Call {businessName} at {businessPhone}.', {});
    expect(r.missing).toEqual(['businessName', 'businessPhone']);
    expect(r.text).toBe('Call at.');
  });

  it('keeps texts in the plain alphabet', () => {
    const r = renderNudge('Hi {firstName}, it’s {leadTitle} time — reply here', {
      firstName: 'Maria',
      leadTitle: 'tune-up',
    });
    expect(r.text).toBe("Hi Maria, it's tune-up time - reply here");
  });
});

describe('checkNudgeTemplate', () => {
  it('passes the default message', () => {
    expect(checkNudgeTemplate(DEFAULT_NUDGE_TEMPLATE, ctx)).toEqual({ ok: true, problems: [] });
  });

  it('passes the business’s own number, links and address', () => {
    const own =
      'Hi {firstName}, {senderName} here from {businessName}. Want to pick a time? Call {businessPhone}, email office@lonestarhvac.com or book at https://lonestarhvac.com/book';
    expect(checkNudgeTemplate(own, ctx)).toEqual({ ok: true, problems: [] });
    expect(checkNudgeTemplate('Questions? Call (512) 555-0100.', ctx).ok).toBe(true);
    expect(checkNudgeTemplate('Reply STOP to opt out.', ctx).ok).toBe(true);
  });

  it('needs words', () => {
    expect(checkNudgeTemplate('  ', ctx)).toEqual({
      ok: false,
      problems: [{ code: 'empty', message: 'Write the follow-up message.' }],
    });
  });

  it('fills in only the five placeholders', () => {
    expect(messages('Hi {name}, your {price} quote is ready')).toEqual([
      '{name} can’t be filled in. Use {firstName}, {businessName}, {leadTitle}, {senderName} or {businessPhone}.',
      '{price} can’t be filled in. Use {firstName}, {businessName}, {leadTitle}, {senderName} or {businessPhone}.',
    ]);
    expect(messages('Hi {{firstName}}')).toEqual([
      'Use single braces: {firstName}, not {{firstName}}.',
    ]);
    expect(nudgePlaceholderProblem('Hi {firstName} and {leadTitle}')).toBeNull();
    expect(problemCodes('Hi [Customer Name], checking in')).toEqual(['placeholder']);
  });

  it('never gives an amount or a price', () => {
    expect(messages('Save $50 on your tune-up this week!')).toEqual([
      'The message quotes $50, and prices aren’t allowed',
    ]);
    expect(problemCodes('Tune-ups are only 89 dollars')).toEqual(['money']);
    expect(problemCodes('Get 10% off if you book this week')).toContain('money');
    expect(problemCodes('Book your free estimate today')).toEqual(['money']);
  });

  it('never links anywhere but the business’s own site', () => {
    expect(messages('See our reviews at yelp.com/lonestar')).toEqual([
      'The message links to yelp.com/lonestar, which isn’t one of the business’s own links',
    ]);
    expect(problemCodes('Book at https://calendly.com/dale')).toEqual(['link']);
  });

  it('never gives another number or address', () => {
    expect(messages('Call Dale on his cell, 512-555-9999')).toEqual([
      'The message gives 512-555-9999, which isn’t the business’s number.',
    ]);
    expect(messages('Email dale@gmail.com')).toEqual([
      'The message gives dale@gmail.com, which isn’t the business’s address.',
    ]);
  });

  it('never asks for a reply the carriers read as a keyword', () => {
    expect(messages('Reply YES to book a time')).toEqual([
      'Don’t ask them to reply YES: carriers treat it as START, a request to get texts.',
    ]);
    expect(messages('Reply CANCEL if you’re no longer interested')).toEqual([
      'Don’t ask them to reply CANCEL: carriers treat it like STOP and opt them out of texts.',
    ]);
    expect(problemCodes('Text HELP for options')).toEqual(['keyword']);
  });

  it('keeps it to two texts', () => {
    const long = `Hi {firstName}, ${'just checking in. '.repeat(20)}`;
    expect(messages(long)).toEqual([
      expect.stringMatching(
        /^With a name filled in, this text is \d+ characters\. Keep it to 320\.$/,
      ),
    ]);
  });

  it('lists every problem at once', () => {
    expect(problemCodes('Save $50 at deals.example.com, reply YES {code}')).toEqual([
      'placeholder',
      'money',
      'link',
      'keyword',
    ]);
  });
});
