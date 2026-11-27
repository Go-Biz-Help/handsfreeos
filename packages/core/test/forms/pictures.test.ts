import { describe, expect, it } from 'vitest';
import {
  applyFormOps,
  asksSomething,
  FormDesign,
  formLook,
  formProblems,
  formToolCallsToOps,
  nextQuestion,
  questionLine,
  questionRows,
  type AiFormCall,
  type FormDefinition,
  type QuestionInput,
} from '../../src/forms/index';
import { PictureRef } from '../../src/look/pictures';
import { choice, def, page, pickOne, qid, result, shortText } from './fixtures';

/**
 * Pictures and layout on forms (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md, part 2): a picture on the page, its
 * size, where it sits and what it opens; pictures on choices; questions side by side; the design's Line up, cover and
 * picture behind; and the AI builder adding them.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const PIC = { path: `${WS}/22222222-2222-4222-8222-222222222222.webp`, width: 1200, height: 800 };

const picture = (name: string, config: Record<string, unknown> = {}): QuestionInput =>
  ({ id: qid(name), type: 'picture', title: name, config }) as QuestionInput;

const one = (questions: QuestionInput[]): FormDefinition =>
  def({ pages: [page('about', questions)], results: [result('thanks')] });

describe('a picture on a form', () => {
  it('starts large and centred, with no link, and asks nothing', () => {
    const form = one([picture('crew', { picture: PIC })]);
    const q = form.pages[0]!.questions[0]!;
    expect(q.config).toEqual({ picture: PIC, size: 'large', align: 'center', link: '' });
    expect(q.width).toBe('full');
    expect(asksSomething(q)).toBe(false);
    // Nothing to answer: the next question to ask is past it.
    const asked = one([picture('crew', { picture: PIC }), shortText('name')]);
    expect(nextQuestion(asked, {})?.id).toBe(qid('name'));
  });

  it('holds back Publish while it has no picture, or a link that isn’t a web page', () => {
    expect(formProblems(one([picture('Our truck')]))).toContain(
      '“Our truck” has no picture yet. Open it on the Questions tab and pick one from Your pictures.',
    );
    expect(
      formProblems(one([picture('Our truck', { picture: PIC, link: 'javascript:alert(1)' })])),
    ).toContain(
      'The link on “Our truck” isn’t a web address. Give one starting with https://, or leave it blank.',
    );
    expect(
      formProblems(one([picture('Our truck', { picture: PIC, link: 'https://example.com' })])),
    ).toEqual([]);
  });

  it('takes only a picture from Your pictures, never a made-up address', () => {
    expect(PictureRef.safeParse(PIC).success).toBe(true);
    expect(PictureRef.safeParse({ ...PIC, path: 'https://evil.example/x.webp' }).success).toBe(
      false,
    );
    expect(PictureRef.safeParse({ ...PIC, path: `${WS}/../secret.webp` }).success).toBe(false);
  });

  it('says what it is in the editor’s words', () => {
    const form = one([picture('crew'), shortText('name', { width: 'half' })]);
    expect(questionLine(form.pages[0]!.questions[0]!)).toContain('no picture yet');
    expect(questionLine(form.pages[0]!.questions[1]!)).toContain('half width');
  });

  it('lets a choice carry a picture, and Undo takes it off again', () => {
    const start = one([pickOne('roof', [choice('Shingle'), choice('Metal')])]);
    expect(start.pages[0]!.questions[0]!.config).toMatchObject({
      choices: [{ picture: null }, { picture: null }],
    });
    const { definition, inverse } = applyFormOps(start, [
      {
        op: 'update_question',
        questionId: qid('roof'),
        patch: { config: { choices: [{ id: choice('Shingle').id, picture: PIC }] } },
      },
    ]);
    expect(definition.pages[0]!.questions[0]!.config).toMatchObject({
      choices: [
        { label: 'Shingle', picture: PIC },
        { label: 'Metal', picture: null },
      ],
    });
    expect(applyFormOps(definition, inverse).definition).toEqual(start);
  });
});

describe('questions side by side', () => {
  const q = (id: string, width: 'full' | 'half') => ({ id, width });

  it('pairs two half-width questions next to each other, and leaves the rest a row each', () => {
    const rows = questionRows([
      q('first', 'half'),
      q('last', 'half'),
      q('email', 'full'),
      q('city', 'half'),
      q('zip', 'half'),
      q('notes', 'half'),
    ]);
    expect(rows.map((r) => r.map((x) => x.id))).toEqual([
      ['first', 'last'],
      ['email'],
      ['city', 'zip'],
      ['notes'],
    ]);
  });

  it('never pairs across a full-width one', () => {
    expect(
      questionRows([q('a', 'half'), q('b', 'full'), q('c', 'half')]).map((r) => r.length),
    ).toEqual([1, 1, 1]);
  });
});

describe('the design’s pictures and Line up', () => {
  it('starts lined up left with no pictures, and hands what it picks to the page', () => {
    const plain = formLook(FormDesign.parse({}));
    expect(plain.align).toBe('left');
    expect(plain.cover).toBeNull();
    expect(plain.backdrop).toBeNull();
    const look = formLook(FormDesign.parse({ align: 'center', cover: PIC, backdrop: PIC }));
    expect(look.data['data-align']).toBe('center');
    expect(look.cover).toEqual(PIC);
    expect(look.backdrop).toEqual(PIC);
  });

  it('refuses a cover that isn’t from Your pictures', () => {
    expect(FormDesign.safeParse({ cover: { ...PIC, path: 'x.png' } }).success).toBe(false);
  });
});

describe('the AI builder', () => {
  const call = (name: string, args: Record<string, unknown>): AiFormCall => ({
    id: name,
    name,
    arguments: args,
  });

  it('adds a picture and two questions side by side', () => {
    const out = formToolCallsToOps(
      [
        call('add_question', {
          type: 'picture',
          title: 'Our crew at a job',
          help: 'Here since 2009',
          json: JSON.stringify({ picture: PIC, size: 'medium', align: 'right' }),
        }),
        call('add_question', { type: 'short_text', title: 'First name', width: 'half' }),
        call('add_question', { type: 'short_text', title: 'Last name', width: 'half' }),
      ],
      one([]),
    );
    expect(out.results.every((r) => r.ok)).toBe(true);
    const [pic, first, last] = out.definition.pages[0]!.questions;
    expect(pic).toMatchObject({
      type: 'picture',
      help: 'Here since 2009',
      config: { picture: PIC, size: 'medium', align: 'right', link: '' },
    });
    expect([first!.width, last!.width]).toEqual(['half', 'half']);
  });

  it('refuses a picture it made up', () => {
    const out = formToolCallsToOps(
      [
        call('add_question', {
          type: 'picture',
          title: 'A roof',
          json: JSON.stringify({
            picture: { path: 'https://x.test/roof.jpg', width: 1, height: 1 },
          }),
        }),
      ],
      one([]),
    );
    expect(out.results[0]!.ok).toBe(false);
  });
});
