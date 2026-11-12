'use client';
/**
 * The microphone's raw samples, from an audio worklet that only hands them over (128 at a time) for the page to turn
 * into what it sends: a live test call's phone audio, and the Assistant's live listening. One copy, loaded once per
 * AudioContext.
 */

const MIC_WORKLET = `
class HfosPhoneMic extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('hfos-phone-mic', HfosPhoneMic);
`;

export const MIC_WORKLET_NAME = 'hfos-phone-mic';

let url: string | null = null;
const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

/** Loads the worklet into `ctx` (once): then `new AudioWorkletNode(ctx, MIC_WORKLET_NAME)` hands over samples. */
export function loadMicWorklet(ctx: BaseAudioContext): Promise<void> {
  let done = loaded.get(ctx);
  if (!done) {
    url ??= URL.createObjectURL(new Blob([MIC_WORKLET], { type: 'text/javascript' }));
    done = ctx.audioWorklet.addModule(url);
    // A failed load can be tried again.
    done.catch(() => loaded.delete(ctx));
    loaded.set(ctx, done);
  }
  return done;
}
