/**
 * Photo-style pictures from OpenAI's image model, for the business's own social posts
 * (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md, decision 14; docs/socialcontent.md, "Making posts"). The AI
 * describes the scene as it writes the post; this turns that into a picture. Pictures with words on them are drawn
 * by the worker itself from Claude's design (addons/socialcontent/draw.ts), never here: image models still garble
 * words.
 *
 * Each picture is charged per picture as `ai.image` by the job that asked (addons/socialcontent/content.ts), and the
 * charge keeps what OpenAI really counted for it (`usage`), so the 9¢ can be checked against the real cost.
 *
 * **The models** (owner's picks, 11 Nov 2026): OPENAI_IMAGE_MODEL makes every picture, `gpt-image-2.6-sunburst`
 * (made for detail) unless set. When it's busy, down or gone, OPENAI_IMAGE_BACKUP_MODEL (`gpt-image-2.6-flare`, made
 * for speed) tries once before the picture fails. OPENAI_IMAGE_COMPLEXITY (`medium`) is how much the 2.6 models plan
 * a picture before making it: more takes longer, never costs more. `gpt-image-2` is removed from the API on
 * 10 Feb 2027 and takes no complexity, so it's never sent one.
 *
 * **Null without OPENAI_API_KEY** (local runs, tests): photo-style pictures are then designed instead, and the post
 * says so.
 */

export type PictureComplexity = 'low' | 'medium' | 'high';
export const PICTURE_COMPLEXITIES: readonly PictureComplexity[] = ['low', 'medium', 'high'];

export const DEFAULT_PICTURE_MODEL = 'gpt-image-2.6-sunburst';
export const DEFAULT_PICTURE_BACKUP_MODEL = 'gpt-image-2.6-flare';
export const DEFAULT_PICTURE_COMPLEXITY: PictureComplexity = 'medium';

/** What OpenAI counted for one picture, and what that costs at its listed prices. */
export interface PictureUsage {
  readonly inputTextTokens: number;
  readonly inputImageTokens: number;
  readonly outputImageTokens: number;
  readonly outputTextTokens: number;
  /** In millionths of a dollar: 60_000 is 6¢. */
  readonly costMicros: number;
}

export interface MadePicture {
  /** PNG bytes. */
  readonly bytes: Buffer;
  /** The model that made it: the backup's name when the first was busy. */
  readonly model: string;
  /** Null when OpenAI sent no counts back. */
  readonly usage: PictureUsage | null;
}

export interface PictureMaker {
  /** The model asked first, for the record. */
  readonly model: string;
  /** The model tried once when the first is busy, down or gone; null for none. */
  readonly backupModel: string | null;
  /** One portrait picture (1024x1536). Throws PictureError. */
  make(prompt: string, opts?: { readonly signal?: AbortSignal }): Promise<MadePicture>;
}

export class PictureError extends Error {
  constructor(
    message: string,
    /** Worth trying again later: OpenAI busy or down, not a refusal of what was asked. */
    readonly retryable: boolean,
    /** OpenAI turned down what was asked (its safety system): the words to say so. */
    readonly refused = false,
    /** The model itself isn't there (a wrong name, or retired): worth asking the backup, not the same one again. */
    readonly modelGone = false,
  ) {
    super(message);
    this.name = 'PictureError';
  }
}

/**
 * OpenAI's listed prices, in millionths of a dollar per token (11 Nov 2026, the same for `gpt-image-2` and both
 * 2.6 models): text in $5 per million, image in $8, image out $30. Text out has no listed price; it's counted as
 * image out to be safe.
 */
const PRICE_MICROS_PER_TOKEN = { textIn: 5, imageIn: 8, imageOut: 30 } as const;

const ENDPOINT = 'https://api.openai.com/v1/images/generations';
/**
 * The first model's time, then the backup's (the fast one): together well inside the five minutes a job holds its
 * lease (jobs.ts), so a slow OpenAI never has a second worker start the same picture.
 */
const TIMEOUT_MS = 150_000;
const BACKUP_TIMEOUT_MS = 90_000;

/** Only the 2.6 models and later take `complexity`; an older one refuses a request that carries it. */
export function takesComplexity(model: string): boolean {
  const m = /^gpt-image-(\d+)\.(\d+)-/.exec(model);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 2 || (major === 2 && minor >= 6);
}

/** OPENAI_IMAGE_COMPLEXITY as set, or the default; null when it's something else. */
export function pictureComplexityOf(raw: string | undefined): PictureComplexity | null {
  const v = (raw?.trim().toLowerCase() || DEFAULT_PICTURE_COMPLEXITY) as PictureComplexity;
  return PICTURE_COMPLEXITIES.includes(v) ? v : null;
}

/** OPENAI_IMAGE_BACKUP_MODEL as set, or the default; `none` (or the main model again) for no backup. */
export function pictureBackupModelOf(raw: string | undefined, model: string): string | null {
  const v = raw?.trim() || DEFAULT_PICTURE_BACKUP_MODEL;
  if (v.toLowerCase() === 'none' || v === model) return null;
  return v;
}

interface OpenAiUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number };
  output_tokens_details?: { text_tokens?: number; image_tokens?: number };
}

/** What a picture cost, from the counts OpenAI sent back. */
export function pictureUsageOf(u: OpenAiUsage | null | undefined): PictureUsage | null {
  if (!u || typeof u !== 'object') return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const inputTotal = n(u.input_tokens);
  const inputImageTokens = n(u.input_tokens_details?.image_tokens);
  const inputTextTokens = u.input_tokens_details
    ? n(u.input_tokens_details.text_tokens)
    : Math.max(0, inputTotal - inputImageTokens);
  const outputTotal = n(u.output_tokens);
  const outputTextTokens = n(u.output_tokens_details?.text_tokens);
  const outputImageTokens = u.output_tokens_details
    ? n(u.output_tokens_details.image_tokens)
    : outputTotal;
  if (!inputTotal && !outputTotal && !inputImageTokens && !outputImageTokens) return null;
  const costMicros =
    inputTextTokens * PRICE_MICROS_PER_TOKEN.textIn +
    inputImageTokens * PRICE_MICROS_PER_TOKEN.imageIn +
    (outputImageTokens + outputTextTokens) * PRICE_MICROS_PER_TOKEN.imageOut;
  return { inputTextTokens, inputImageTokens, outputImageTokens, outputTextTokens, costMicros };
}

export function createPictures(
  apiKey: string | null,
  opts: {
    readonly model: string;
    readonly backupModel?: string | null;
    readonly complexity?: PictureComplexity;
    /** For tests. */
    readonly fetch?: typeof fetch;
  },
): PictureMaker | null {
  if (!apiKey) return null;
  const model = opts.model;
  const backupModel = opts.backupModel && opts.backupModel !== model ? opts.backupModel : null;
  const complexity = opts.complexity ?? DEFAULT_PICTURE_COMPLEXITY;
  const send = opts.fetch ?? fetch;

  async function ask(
    use: string,
    prompt: string,
    signal: AbortSignal | undefined,
    ms: number,
  ): Promise<MadePicture> {
    const timeout = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(ms)])
      : AbortSignal.timeout(ms);
    let res: Response;
    try {
      res = await send(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: use,
          prompt: prompt.slice(0, 4000),
          size: '1024x1536',
          quality: 'medium',
          ...(takesComplexity(use) ? { complexity } : {}),
          n: 1,
        }),
        signal: timeout,
      });
    } catch (e) {
      // Our own caller giving up isn't OpenAI being down: nothing to hand to the backup.
      if (signal?.aborted) throw e;
      throw new PictureError(
        `OpenAI’s image AI didn’t answer: ${e instanceof Error ? e.message : String(e)}`,
        true,
      );
    }
    const body = (await res.json().catch(() => null)) as {
      data?: { b64_json?: string }[];
      usage?: OpenAiUsage;
      error?: { message?: string; code?: string };
    } | null;
    if (!res.ok) {
      const code = body?.error?.code ?? '';
      const refused = code === 'moderation_blocked' || code === 'content_policy_violation';
      const gone = !refused && (res.status === 404 || code === 'model_not_found');
      throw new PictureError(
        refused
          ? 'OpenAI’s image AI wouldn’t make that picture. Change what it shows, or have it designed instead.'
          : `OpenAI’s image AI said ${res.status}${body?.error?.message ? `: ${body.error.message.slice(0, 200)}` : ''}`,
        !refused && (res.status === 429 || res.status >= 500),
        refused,
        gone,
      );
    }
    const b64 = body?.data?.[0]?.b64_json;
    if (!b64) throw new PictureError('OpenAI’s image AI sent no picture back.', true);
    return { bytes: Buffer.from(b64, 'base64'), model: use, usage: pictureUsageOf(body?.usage) };
  }

  return {
    model,
    backupModel,
    async make(prompt, o = {}) {
      try {
        return await ask(model, prompt, o.signal, TIMEOUT_MS);
      } catch (e) {
        // A refusal, or a request OpenAI turned down as asked, would be turned down by the backup too.
        const worthBackup = e instanceof PictureError && (e.retryable || e.modelGone);
        if (!backupModel || !worthBackup) throw e;
        return await ask(backupModel, prompt, o.signal, BACKUP_TIMEOUT_MS);
      }
    },
  };
}
