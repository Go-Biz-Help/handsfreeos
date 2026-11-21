import { describe, expect, it } from 'vitest';
import {
  allQuestions,
  answerProblem,
  filesAnswerWords,
  recordAnswers,
  uploadAcceptAttr,
  uploadLimitBytes,
  uploadRefusal,
  uploadTypeOf,
  type Question,
  type QuestionInput,
} from '../../src/forms/index';
import { def, page, qid, shortText } from './fixtures';

const fileQuestion = (name: string, config: Record<string, unknown> = {}): QuestionInput =>
  ({ id: qid(name), type: 'file', title: name, config }) as QuestionInput;

const formWith = (config: Record<string, unknown> = {}, extra: Partial<QuestionInput> = {}) =>
  def({
    pages: [
      page('about', [
        shortText('name'),
        { ...fileQuestion('design', config), ...extra } as QuestionInput,
      ]),
    ],
  });

const designOf = (form: ReturnType<typeof def>): Question =>
  allQuestions(form).find((q) => q.type === 'file')!;

const file = (name: string, bytes = 1000) => ({
  fileId: '00000000-0000-4000-8000-000000000001',
  name,
  bytes,
});

describe('Files on a public form', () => {
  it('goes by the name when the browser doesn’t say what a file is', () => {
    expect(uploadTypeOf('IMG_1234.HEIC', '')).toBe('image/heic');
    expect(uploadTypeOf('order.csv', 'application/octet-stream')).toBe('text/csv');
    expect(uploadTypeOf('logo.png', 'image/png')).toBe('image/png');
    expect(uploadTypeOf('mystery.bin', '')).toBe('application/octet-stream');
  });

  it('takes what the question’s setting takes, in the bucket’s sizes', () => {
    const photos = designOf(formWith({ accept: 'image', maxMb: 5 }));
    expect(uploadRefusal(photos, { name: 'a.png', mimeType: 'image/png', sizeBytes: 1000 })).toBe(
      null,
    );
    expect(
      uploadRefusal(photos, { name: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 1000 })?.rule,
    ).toBe('form_file_type');
    expect(
      uploadRefusal(photos, {
        name: 'big.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 6 * 1024 * 1024,
      }),
    ).toMatchObject({ rule: 'form_file_too_big', message: expect.stringMatching(/up to 5 MB/) });
    // Never past what the business's files take, whatever the question says.
    expect(uploadLimitBytes(designOf(formWith({ maxMb: 25 })))).toBe(25 * 1024 * 1024);
  });

  it('tells a designer how to send an Illustrator file', () => {
    const any = designOf(formWith());
    expect(
      uploadRefusal(any, {
        name: 'shirt-front.ai',
        mimeType: 'application/postscript',
        sizeBytes: 1000,
      })?.message,
    ).toBe(
      'shirt-front.ai is a design file this form can’t take. Save it as a PDF or a PNG and add that.',
    );
  });

  it('offers the picker only what the question takes', () => {
    const accept = uploadAcceptAttr(designOf(formWith({ accept: 'image' })));
    expect(accept).toContain('image/heic');
    expect(accept).toContain('.jpg');
    expect(accept).not.toContain('application/pdf');
  });

  it('holds the answer to how many files and how big', () => {
    const design = designOf(formWith({ maxFiles: 2, maxMb: 1 }, { required: true }));
    expect(answerProblem(design, [file('a.png')])).toBeNull();
    expect(answerProblem(design, [file('a.png'), file('b.png'), file('c.png')])).toBe(
      'Up to 2 files.',
    );
    expect(answerProblem(design, [file('a.png', 2 * 1024 * 1024)])).toBe(
      'Each file can be up to 1 MB.',
    );
    expect(answerProblem(design, [{ nope: true }] as never)).toBe('Add the file again.');
    expect(answerProblem(design, [])).toMatch(/answer/i);
  });

  it('records the files with their names in words', () => {
    const form = formWith();
    const design = designOf(form);
    const [, recorded] = recordAnswers(form, {
      [design.id]: [file('front.png'), file('back.pdf')],
    });
    expect(recorded!.words).toBe('2 files: front.png, back.pdf');
    expect(recorded!.value).toHaveLength(2);
    expect(filesAnswerWords([file('front.png')])).toBe('front.png');
    expect(filesAnswerWords([])).toBeNull();
  });
});
