/**
 * Photo-style pictures from OpenAI's image model, for the business's own social posts
 * (HANDSFREEOS_CONTENT_CREATOR_IMPLEMENTATION_PLAN.md, decision 14; docs/socialcontent.md, "Making posts"). The AI
 * describes the scene as it writes the post; this turns that into a picture. Pictures with words on them are drawn
 * by the worker itself from Claude's design (addons/socialcontent/draw.ts), never here: image models still garble
 * words.
 *
 * Each picture is charged per picture as `ai.image` by whoever asks (money/usage-capture.ts, `chargeAiImage`).
 *
 * **Null without OPENAI_API_KEY** (local runs, tests): photo-style pictures are then designed instead, and the post
 * says so. The model is OPENAI_IMAGE_MODEL.
 */

export interface PictureMaker {
  /** The model asked, for the record. */
  readonly model: string;
  /** One portrait picture (1024x1536), as PNG bytes. Throws PictureError. */
  make(prompt: string, opts?: { readonly signal?: AbortSignal }): Promise<Buffer>;
}

export class PictureError extends Error {
  constructor(
    message: string,
    /** Worth trying again later: OpenAI busy or down, not a refusal of what was asked. */
    readonly retryable: boolean,
    /** OpenAI turned down what was asked (its safety system): the words to say so. */
    readonly refused = false,
  ) {
    super(message);
    this.name = 'PictureError';
  }
}

const ENDPOINT = 'https://api.openai.com/v1/images/generations';
const TIMEOUT_MS = 150_000;

export function createPictures(apiKey: string | null, model: string): PictureMaker | null {
  if (!apiKey) return null;
  return {
    model,
    async make(prompt, opts = {}) {
      const signal = opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(TIMEOUT_MS)])
        : AbortSignal.timeout(TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt: prompt.slice(0, 4000),
            size: '1024x1536',
            quality: 'medium',
            n: 1,
          }),
          signal,
        });
      } catch (e) {
        throw new PictureError(
          `OpenAI’s image AI didn’t answer: ${e instanceof Error ? e.message : String(e)}`,
          true,
        );
      }
      const body = (await res.json().catch(() => null)) as {
        data?: { b64_json?: string }[];
        error?: { message?: string; code?: string };
      } | null;
      if (!res.ok) {
        const code = body?.error?.code ?? '';
        const refused = code === 'moderation_blocked' || code === 'content_policy_violation';
        throw new PictureError(
          refused
            ? 'OpenAI’s image AI wouldn’t make that picture. Change what it shows, or have it designed instead.'
            : `OpenAI’s image AI said ${res.status}${body?.error?.message ? `: ${body.error.message.slice(0, 200)}` : ''}`,
          !refused && (res.status === 429 || res.status >= 500),
          refused,
        );
      }
      const b64 = body?.data?.[0]?.b64_json;
      if (!b64) throw new PictureError('OpenAI’s image AI sent no picture back.', true);
      return Buffer.from(b64, 'base64');
    },
  };
}
