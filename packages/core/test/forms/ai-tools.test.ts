import { describe, expect, it } from 'vitest';
import {
  allQuestions,
  describeFormOps,
  diffForms,
  formForModel,
  formToolCallsToOps,
  questionLine,
  ruleText,
  applyFormOps,
  FORM_BUILDER_TOOLS,
  type AiFormCall,
  type FormDefinition,
} from '../../src/forms/index';
import { rng } from '../calendar/random';
import { choice, def, page, pickOne, pid, qid, shortText } from './fixtures';

/** Ids the tests can predict, so a diff of tool calls reads the same every run. */
const seeded = () => {
  const random = rng(7);
  return () => random.float();
};

const call = (name: string, args: Record<string, unknown>, id = name): AiFormCall => ({
  id,
  name,
  arguments: args,
});

const build = (definition: FormDefinition, calls: AiFormCall[]) =>
  formToolCallsToOps(calls, definition, seeded());

describe('the builder’s tool schemas', () => {
  // Claude takes at most 16 values that may be one of several types across a request's strict tools, and refuses
  // the whole request past them: these had 21 and the builder never got an answer (2026-11-11). The limits
  // themselves are checked in the worker's ai-anthropic test.
  it('are flat and strict, and what the model may leave out is optional, never null', () => {
    for (const tool of FORM_BUILDER_TOOLS) {
      const schema = tool.inputSchema as {
        type: string;
        properties: Record<string, Record<string, unknown>>;
        required: string[];
        additionalProperties: boolean;
      };
      expect(tool.strict).toBe(true);
      expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
      for (const key of schema.required) expect(schema.properties).toHaveProperty(key);
      for (const prop of Object.values(schema.properties)) {
        expect(prop).not.toHaveProperty('anyOf');
        expect(Array.isArray(prop.type)).toBe(false);
      }
    }
  });

  it('take a call that leaves out what it doesn’t need', () => {
    const out = build(def({ pages: [page('about', [])] }), [
      call('add_question', { type: 'short_text', title: 'Your name', mapTo: 'person.first_name' }),
      call('add_page', {}),
      call('set_form', { title: 'Get a quote' }),
    ]);
    expect(out.results.every((r) => r.ok)).toBe(true);
    expect(out.definition.pages).toHaveLength(2);
    expect(allQuestions(out.definition)).toEqual([
      expect.objectContaining({ title: 'Your name', mapTo: 'person.first_name' }),
    ]);
  });
});

describe('the AI builder', () => {
  it('builds a quote form out of tool calls', () => {
    const out = build(def({ title: 'Quote request', pages: [page('about', [])] }), [
      call('set_form', { mode: 'form', title: 'Get a quote', intro: 'Two minutes, tops.' }),
      call('add_question', {
        ref: 'name',
        pageId: null,
        index: null,
        type: 'short_text',
        title: 'Your name',
        help: null,
        required: true,
        mapTo: 'person.first_name',
        json: null,
        showIfJson: null,
      }),
      call('add_question', {
        ref: 'sqft',
        pageId: null,
        index: null,
        type: 'number',
        title: 'How many square feet?',
        help: null,
        required: true,
        mapTo: null,
        json: '{"unit":"sq ft"}',
        showIfJson: null,
      }),
      call('add_calculation', {
        ref: 'quote',
        json: '{"name":"Quote","terms":[{"factors":[{"kind":"question","questionId":"sqft"},{"kind":"number","value":3.5}]},{"factors":[{"kind":"number","value":75}]}],"format":"money"}',
      }),
      call('finish', { summary: 'Asks for the square footage and quotes on the spot.' }),
    ]);

    expect(out.results.every((r) => r.ok)).toBe(true);
    expect(out.finish?.summary).toContain('square footage');
    expect(out.definition.title).toBe('Get a quote');
    expect(allQuestions(out.definition).map((q) => q.title)).toEqual([
      'Your name',
      'How many square feet?',
    ]);
    // The calculation points at the question the model called "sqft" by its real id.
    const factor = out.definition.calculations[0]!.terms[0]!.factors[0]!;
    expect(factor.kind === 'question' && factor.questionId).toBe(
      allQuestions(out.definition)[1]!.id,
    );
  });

  it('makes the choices’ ids itself, and tells the model what they are', () => {
    const out = build(def({ pages: [page('about', [])] }), [
      call('add_question', {
        ref: null,
        pageId: null,
        index: null,
        type: 'choice',
        title: 'Which service?',
        help: null,
        required: null,
        mapTo: null,
        json: '{"choices":[{"label":"Mowing"},{"label":"Trimming"}]}',
        showIfJson: null,
      }),
    ]);
    const question = allQuestions(out.definition)[0]!;
    const choices = (question.config as { choices: { id: string; label: string }[] }).choices;
    expect(choices.map((c) => c.label)).toEqual(['Mowing', 'Trimming']);
    expect(choices[0]!.id).toMatch(/^c_[a-z0-9]{8}$/);
    expect(out.results[0]!.message).toContain(choices[0]!.id);
  });

  it('hands a bad call back to the model instead of half-changing the form', () => {
    const start = def({ pages: [page('about', [shortText('name')])] });
    const out = build(start, [
      call('update_question', { questionId: 'q_ghost00', json: '{"title":"Nope"}' }, 'bad'),
      call('set_form', { mode: null, title: 'Still fine', intro: null }, 'good'),
    ]);
    expect(out.results[0]!.ok).toBe(false);
    expect(out.results[0]!.message).toContain('no question');
    expect(out.results[1]!.ok).toBe(true);
    expect(out.definition.title).toBe('Still fine');
    expect(out.ops).toHaveLength(1);
  });

  it('refuses settings that don’t fit the kind of question', () => {
    const out = build(def(), [
      call('add_question', {
        ref: null,
        pageId: null,
        index: null,
        type: 'choice',
        title: 'Which service?',
        help: null,
        required: null,
        mapTo: null,
        json: '{"choices":[{"label":"Only one"}]}',
        showIfJson: null,
      }),
    ]);
    expect(out.results[0]!.ok).toBe(false);
    expect(out.results[0]!.message).toContain('choices');
    expect(out.ops).toHaveLength(0);
  });

  it('puts a new result above the thank-you screen, so a rule can win', () => {
    const out = build(def(), [
      call('add_result', {
        ref: null,
        name: 'Gold',
        headline: 'You want the Gold plan',
        body: null,
        showIfJson:
          '{"match":"all","conditions":[{"source":{"kind":"percent"},"op":"gte","value":80}]}',
      }),
    ]);
    expect(out.definition.results.map((r) => r.name)).toEqual(['Gold', 'thanks']);
  });

  it('sets a live poll’s points and who to follow up with, as the editor does', () => {
    const start = def({
      mode: 'poll',
      pages: [page('about', [pickOne('source', [choice('Ads'), choice('Referrals')])])],
    });
    const ads = allQuestions(start)[0]!.config as { choices: { id: string }[] };
    const out = build(start, [
      call('update_question', {
        questionId: qid('source'),
        json: JSON.stringify({ live: { points: { [ads.choices[0]!.id]: 10 } } }),
      }),
      call('set_form', {
        mode: null,
        title: null,
        intro: null,
        leadsJson: '{"stayed": 5, "hot": 25, "warm": 10, "hotAction": "home"}',
      }),
    ]);
    expect(out.results.every((r) => r.ok)).toBe(true);
    expect(out.definition.leads).toEqual({ stayed: 5, hot: 25, warm: 10, hotAction: 'home' });
    expect(
      (allQuestions(out.definition)[0]!.live as { points: Record<string, number> }).points,
    ).toEqual({ [ads.choices[0]!.id]: 10 });
  });

  it('renames a page, saves their details on it, and takes a page break out as the editor does', () => {
    const start = def({
      pages: [
        page('about', [shortText('name')]),
        page('job', [shortText('what'), shortText('when')]),
      ],
    });
    const out = build(start, [
      call('update_page', { pageId: pid('about'), title: 'You', savesContact: true }),
      call('delete_page', { pageId: pid('job') }),
    ]);
    expect(out.results.every((r) => r.ok)).toBe(true);
    expect(out.definition.pages).toHaveLength(1);
    expect(out.definition.pages[0]!.title).toBe('You');
    expect(out.definition.pages[0]!.savesContact).toBe(true);
    // Its questions join the end of the page before, in their order, rather than going with it.
    expect(out.definition.pages[0]!.questions.map((q) => q.id)).toEqual([
      qid('name'),
      qid('what'),
      qid('when'),
    ]);
  });

  it('won’t take out the first page', () => {
    const out = build(def(), [call('delete_page', { pageId: pid('about') })]);
    expect(out.results[0]).toMatchObject({
      ok: false,
      message: 'The first page can’t be taken out.',
    });
    expect(out.ops).toEqual([]);
  });

  it('shows the model the form with its ids', () => {
    const form = def({
      pages: [page('about', [pickOne('service', [choice('Mow'), choice('Trim')])])],
    });
    const text = formForModel(form);
    expect(text).toContain(qid('service'));
    expect(text).toContain('Mow=');
  });
});

describe('saying what changed', () => {
  it('describes each change in the business’s words', () => {
    const before = def({ pages: [page('about', [shortText('name', { title: 'Your name' })])] });
    const lines = describeFormOps(
      [
        { op: 'update_question', questionId: qid('name'), patch: { required: true } },
        { op: 'set_form', patch: { mode: 'quiz' } },
      ],
      before,
    );
    expect(lines).toEqual(['“Your name”: made it required', 'Made it a quiz']);
  });

  it('reads a rule out loud', () => {
    const form = def({
      pages: [
        page('about', [
          pickOne('service', [choice('Mow'), choice('Trim')]),
          shortText('when', {
            showIf: {
              conditions: [
                {
                  source: { kind: 'question', questionId: qid('service') },
                  op: 'is',
                  value: 'c_mow00000',
                },
              ],
            },
          }),
        ]),
      ],
    });
    const question = allQuestions(form)[1]!;
    expect(ruleText(question.showIf, form)).toBe('“service” is Mow');
    expect(questionLine(question)).toContain('only sometimes');
  });

  it('turns one form into another as ops that can be applied', () => {
    const before = def({ pages: [page('about', [shortText('name'), shortText('email')])] });
    const after = applyFormOps(before, [
      { op: 'delete_question', questionId: qid('email') },
      { op: 'update_question', questionId: qid('name'), patch: { required: true } },
    ]).definition;
    const ops = diffForms(before, after);
    expect(applyFormOps(before, ops).definition).toEqual(after);
    expect(describeFormOps(ops, before)).toContain('Deleted “email”');
  });
});
