/**
 * What the call screen says when the camera or microphone doesn't start (docs/video-calls.md, "On the phone"). The
 * phone asks the first time either is turned on; once someone has said no, only the phone's Settings can say yes, so
 * that's what the note offers.
 */
export type Device = 'camera' | 'microphone';

export function mediaProblem(
  error: unknown,
  device: Device,
): { message: string; settings: boolean } {
  const said = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '');
  if (/permission|denied|notallowed|not allowed/i.test(said))
    return {
      message: `HandsFreeOS can’t use your ${device}. Allow it in Settings, then turn it on again.`,
      settings: true,
    };
  return {
    message:
      device === 'camera'
        ? 'Your camera didn’t start. Close any other app using it, then try again.'
        : 'Your microphone didn’t start. Close any other app using it, then try again.',
    settings: false,
  };
}

/** Where the call's sound comes out on Android, by LiveKit's names for them, and what each is called on screen. */
export const AUDIO_OUTPUTS: Readonly<Record<string, string>> = {
  speaker: 'Speaker',
  earpiece: 'Phone',
  headset: 'Headphones',
  bluetooth: 'Bluetooth',
};
