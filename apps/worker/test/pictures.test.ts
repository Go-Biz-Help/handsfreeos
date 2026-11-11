import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createPictures,
  pictureBackupModelOf,
  pictureComplexityOf,
  pictureUsageOf,
  PictureError,
  takesComplexity,
} from '../src/pictures';
import { readEnv } from '../src/env';

/** A stand-in OpenAI: answers each request in turn and keeps what was asked. */
function openAi(...answers: (Response | Error)[]) {
  const asked: Record<string, unknown>[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    asked.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = answers.shift();
    if (!next) throw new Error('asked more times than expected');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { asked, fetchFn };
}

const PNG = Buffer.from('a picture').toString('base64');
const usage = {
  input_tokens: 120,
  input_tokens_details: { text_tokens: 120, image_tokens: 0 },
  output_tokens: 1800,
  output_tokens_details: { image_tokens: 1800, text_tokens: 0 },
  total_tokens: 1920,
};
const picture = () => Response.json({ data: [{ b64_json: PNG }], usage });
const failed = (status: number, code = '', message = 'nope') =>
  Response.json({ error: { code, message } }, { status });

describe('photo-style pictures on OpenAI’s 2.6 image models', () => {
  it('asks Sunburst first, with the complexity, and says what the picture really cost', async () => {
    const { asked, fetchFn } = openAi(picture());
    const maker = createPictures('sk-test', {
      model: 'gpt-image-2.6-sunburst',
      backupModel: 'gpt-image-2.6-flare',
      complexity: 'medium',
      fetch: fetchFn,
    })!;
    const made = await maker.make('A plumber fixing a kitchen sink');
    expect(made.bytes.toString()).toBe('a picture');
    expect(made.model).toBe('gpt-image-2.6-sunburst');
    expect(asked).toEqual([
      expect.objectContaining({
        model: 'gpt-image-2.6-sunburst',
        size: '1024x1536',
        quality: 'medium',
        complexity: 'medium',
      }),
    ]);
    // 120 words in at $5 a million, 1,800 picture pieces out at $30 a million: 5.46¢.
    expect(made.usage).toEqual({
      inputTextTokens: 120,
      inputImageTokens: 0,
      outputImageTokens: 1800,
      outputTextTokens: 0,
      costMicros: 54_600,
    });
  });

  it('tries Flare once when Sunburst is busy or down', async () => {
    for (const first of [failed(429), failed(503), new Error('socket hang up')]) {
      const { asked, fetchFn } = openAi(first, picture());
      const maker = createPictures('sk-test', {
        model: 'gpt-image-2.6-sunburst',
        backupModel: 'gpt-image-2.6-flare',
        fetch: fetchFn,
      })!;
      const made = await maker.make('A roofer on a ladder');
      expect(made.model).toBe('gpt-image-2.6-flare');
      expect(asked.map((a) => a['model'])).toEqual([
        'gpt-image-2.6-sunburst',
        'gpt-image-2.6-flare',
      ]);
    }
  });

  it('tries Flare when Sunburst isn’t there at all', async () => {
    const { fetchFn } = openAi(failed(404, 'model_not_found'), picture());
    const maker = createPictures('sk-test', {
      model: 'gpt-image-2.6-sunburst',
      backupModel: 'gpt-image-2.6-flare',
      fetch: fetchFn,
    })!;
    expect((await maker.make('A bakery counter')).model).toBe('gpt-image-2.6-flare');
  });

  it('never hands a refusal or a bad request to the backup', async () => {
    const refused = openAi(failed(400, 'moderation_blocked'));
    const maker = createPictures('sk-test', {
      model: 'gpt-image-2.6-sunburst',
      backupModel: 'gpt-image-2.6-flare',
      fetch: refused.fetchFn,
    })!;
    const e = await maker.make('Something it won’t make').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PictureError);
    expect((e as PictureError).refused).toBe(true);
    expect(refused.asked).toHaveLength(1);

    const bad = openAi(failed(400, 'invalid_value'));
    const maker2 = createPictures('sk-test', {
      model: 'gpt-image-2.6-sunburst',
      backupModel: 'gpt-image-2.6-flare',
      fetch: bad.fetchFn,
    })!;
    const e2 = await maker2.make('A dog groomer').catch((x: unknown) => x);
    expect((e2 as PictureError).retryable).toBe(false);
    expect(bad.asked).toHaveLength(1);
  });

  it('says it’s worth trying later when both are busy', async () => {
    const { asked, fetchFn } = openAi(failed(503), failed(429));
    const maker = createPictures('sk-test', {
      model: 'gpt-image-2.6-sunburst',
      backupModel: 'gpt-image-2.6-flare',
      fetch: fetchFn,
    })!;
    const e = await maker.make('A florist').catch((x: unknown) => x);
    expect((e as PictureError).retryable).toBe(true);
    expect(asked).toHaveLength(2);
  });

  it('sends no complexity to gpt-image-2, which would refuse it', async () => {
    const { asked, fetchFn } = openAi(picture());
    const maker = createPictures('sk-test', {
      model: 'gpt-image-2',
      backupModel: null,
      fetch: fetchFn,
    })!;
    await maker.make('A car wash');
    expect(asked[0]).not.toHaveProperty('complexity');
    expect(takesComplexity('gpt-image-2')).toBe(false);
    expect(takesComplexity('gpt-image-2.5-sunburst')).toBe(false);
    expect(takesComplexity('gpt-image-2.6-flare')).toBe(true);
    expect(takesComplexity('gpt-image-3.0-sunburst')).toBe(true);
  });

  it('is off without a key', () => {
    expect(createPictures(null, { model: 'gpt-image-2.6-sunburst' })).toBeNull();
  });

  it('works out the cost when OpenAI leaves out the breakdown, and nothing when it sends no counts', () => {
    expect(pictureUsageOf({ input_tokens: 100, output_tokens: 1000 })?.costMicros).toBe(
      100 * 5 + 1000 * 30,
    );
    expect(pictureUsageOf(undefined)).toBeNull();
    expect(pictureUsageOf({})).toBeNull();
  });
});

describe('the image settings', () => {
  it('defaults to Sunburst, Flare as the backup, and medium complexity', () => {
    expect(pictureComplexityOf(undefined)).toBe('medium');
    expect(pictureComplexityOf(' HIGH ')).toBe('high');
    expect(pictureComplexityOf('max')).toBeNull();
    expect(pictureBackupModelOf(undefined, 'gpt-image-2.6-sunburst')).toBe('gpt-image-2.6-flare');
    expect(pictureBackupModelOf('none', 'gpt-image-2.6-sunburst')).toBeNull();
    expect(pictureBackupModelOf('gpt-image-2.6-flare', 'gpt-image-2.6-flare')).toBeNull();
  });

  it('reads them from the worker’s environment', () => {
    const base = {
      DATABASE_URL_WORKER: 'postgresql://hfos_worker:x@h/db',
      SMTP_URL: 'smtp://h',
      WORKER_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    };
    const env = readEnv(base);
    expect(env.openAiImageModel).toBe('gpt-image-2.6-sunburst');
    expect(env.openAiImageBackupModel).toBe('gpt-image-2.6-flare');
    expect(env.openAiImageComplexity).toBe('medium');
    expect(readEnv({ ...base, OPENAI_IMAGE_MODEL: 'gpt-image-2' })).toMatchObject({
      openAiImageModel: 'gpt-image-2',
      openAiImageBackupModel: 'gpt-image-2.6-flare',
    });
    expect(
      readEnv({ ...base, OPENAI_IMAGE_BACKUP_MODEL: 'none' }).openAiImageBackupModel,
    ).toBeNull();
    expect(() => readEnv({ ...base, OPENAI_IMAGE_COMPLEXITY: 'max' })).toThrow(
      'OPENAI_IMAGE_COMPLEXITY must be low, medium or high',
    );
  });
});
