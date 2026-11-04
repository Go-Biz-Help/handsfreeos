import { demoId, isDemoId, mentionsDemo } from './ids';
import { findPhoneScene } from './scenes';
import { currentDemo, keepDemo, type PhoneDemo } from './state';
import type { DemoPress } from './world';
import { PHONE_DEMO_WORDS } from './words';

/**
 * Changes about made-up things (src/demo), answered on the phone and never kept or sent: the queue of changes asks
 * here first (`Changes.change`), so a draft approved on the card or from the lock screen, a reply typed into a made-up
 * conversation, or a made-up conversation read, plays out in the scene and goes nowhere.
 */

/** Plays the scene's next step when it's the one this press plays: a press heard twice plays it once. */
export function playPress(press: DemoPress, demo: PhoneDemo | null = currentDemo()): boolean {
  if (!demo) return false;
  const scene = findPhoneScene(demo.scene);
  const next = scene?.steps[demo.steps.length];
  if (!next || next.press !== press) return false;
  keepDemo({ ...demo, steps: [...demo.steps, Date.now() - demo.startedAt] });
  return true;
}

let typedCount = 0;

export type Pretended = { readonly id: string } | { readonly refused: string } | null;

/**
 * What the demo does with a change, or null when it's a real one. A made-up change's id is made up too, so nothing
 * on the phone or at HandsFreeOS ever finds it.
 */
export function pretendChange(name: string, input: unknown, online: boolean): Pretended {
  if (!mentionsDemo(input)) return null;
  // Asked of HandsFreeOS straight away, a made-up change would only be refused there: it's said here instead.
  if (online) return { refused: PHONE_DEMO_WORDS.notReal };
  const id = demoId((Date.now() % 1_000_000_000) * 100 + (typedCount++ % 100));
  const demo = currentDemo();
  const fields = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (!demo) return { id };
  if (name === 'ai_teammate.decide_draft' && fields['decision'] === 'approve')
    playPress('approve', demo);
  else if (name === 'conversation.mark_read' && isDemoId(fields['conversationId'])) {
    const conversationId = fields['conversationId'];
    if (!demo.read.includes(conversationId))
      keepDemo({ ...demo, read: [...demo.read, conversationId] });
  } else if (
    name === 'message.send' &&
    isDemoId(fields['conversationId']) &&
    typeof fields['body'] === 'string' &&
    fields['body'].trim()
  )
    keepDemo({
      ...demo,
      typed: [
        ...demo.typed,
        {
          id,
          conversationId: fields['conversationId'],
          body: fields['body'].trim(),
          at: Date.now(),
        },
      ],
    });
  return { id };
}
