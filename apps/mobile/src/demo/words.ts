/** The phone's demo player's words (src/demo): Admin → Demo player, and the player over a business's screens. */
export const PHONE_DEMO_WORDS = {
  title: 'Demo player',
  detail: 'Scenes that play on this phone',
  intro:
    'Each scene plays on the real screens of one of your businesses, with made-up customers and messages. Nothing is saved or sent, and Exit leaves the business as it was.',
  playsIn: 'Plays in',
  noBusiness: 'Scenes play inside a business, and you aren’t in one on this phone yet.',
  steps: (count: number) => (count === 1 ? '1 step' : `${count} steps`),
  play: 'Play',
  showScript: 'Voiceover',
  hideScript: 'Hide voiceover',
  scene: (number: number, title: string) => `Scene ${number} · ${title}`,
  step: (n: number, of: number) => `Step ${n} of ${of}`,
  ready: 'Ready. Tap Next to start.',
  next: 'Next',
  back: 'Back',
  again: 'Start over',
  exit: 'Exit',
  hide: 'Hide the player',
  show: 'Show the demo player',
  auto: 'Play on its own, with the player hidden',
  autoHint:
    '▶ plays the scene on its own with this player hidden, each step after its voiceover. Hold the top edge of the screen to stop.',
  autoStop: 'Hold to stop playing on its own',
  done: 'That’s the whole scene. Exit when you’re ready.',
  say: 'Say',
  notificationsOff:
    'Notifications are off for HandsFreeOS on this phone, so nothing will show on the lock screen. Turn them on in Settings → Notifications → HandsFreeOS, then tap Back and Next.',
  pushFailed: 'The notification couldn’t be set up on this phone. Tap Back and Next to try again.',
  notReal: 'That’s part of the demo, so nothing was really changed.',
} as const;
