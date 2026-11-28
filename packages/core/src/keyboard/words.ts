/**
 * The HandsFreeOS keyboard's words (docs/phone-keyboard.md), in one place for the phone's setup screen and for the
 * keyboard itself. The keyboard is native code that can't import this, so the app writes `KEYBOARD_PANEL_WORDS` into
 * the copy it keeps for the keyboard (`buildKeyboardData`), and a wording change reaches the keyboard with the next
 * update of the app. Only what the keyboard must say before it has that copy (no Full Access yet, nobody signed in)
 * lives in the native code, beside the layouts.
 */

/** What the keyboard says, sent to it with the templates and links. */
export const KEYBOARD_PANEL_WORDS = {
  templates: 'Templates',
  links: 'Links',
  /** The tab that goes back to the letters. */
  letters: 'ABC',
  noTemplates: 'No templates yet. Write them on the web in Settings → Templates.',
  noLinks: 'No links yet. Booking pages, live forms, your review link and website show here.',
  /** Above the box a template's first name is typed in. */
  askName: 'Their first name',
  askNameHint: 'Type it, then tap Add',
  add: 'Add',
  /** Adds the template with its fallback word ("there") instead of a name. */
  skip: 'Skip',
  /** The business switcher's heading, when the person is in more than one. */
  switchBusiness: 'Business',
  email: 'Email',
  /** What each kind of link is, under its name. */
  kinds: {
    booking: 'Booking page',
    form: 'Form',
    survey: 'Survey',
    quiz: 'Quiz',
    review: 'Review link',
    website: 'Website',
  },
} as const;

export type KeyboardPanelWords = typeof KEYBOARD_PANEL_WORDS;

/** The fallback a first name gets when it's skipped and the template gives none of its own. */
export const KEYBOARD_NAME_FALLBACK = 'there';

/** "Fill in {{lead.title}} before you send it." Shown on the keyboard after a template with gaps goes in. */
export const keyboardGapsNote = (placeholders: readonly string[]): string =>
  `Fill in ${placeholders.map((p) => `{{${p}}}`).join(', ')} before you send it.`;

/** The phone's Settings → Phone keyboard screen. */
export const KEYBOARD_SETUP_WORDS = {
  title: 'Phone keyboard',
  row: 'Phone keyboard',
  rowDetail: 'Your templates and links in any app',
  intro:
    'Switch to the HandsFreeOS keyboard in any app (texts, Facebook, email) and tap a template or a link to type it in.',
  /** The status line at the top. */
  status: {
    iosWorking: 'On, with Full Access',
    iosNotSeen: 'Not set up yet. Follow the steps below, then open the keyboard once in any app.',
    androidOn: 'On',
    androidCurrent: 'On, and it’s your keyboard now',
    androidOff: 'Not turned on yet',
  },
  iosSteps: [
    'Tap Open Settings.',
    'Tap Keyboards, then turn on HandsFreeOS.',
    'Turn on Allow Full Access, so the keyboard can show your templates and links.',
    'In any app, hold the globe key under the letters and pick HandsFreeOS.',
  ],
  androidSteps: [
    'Tap Turn it on, then switch on HandsFreeOS.',
    'In any app, tap the keyboard button at the bottom of the screen (or Switch keyboard here) and pick HandsFreeOS.',
  ],
  openSettings: 'Open Settings',
  turnOn: 'Turn it on',
  switchKeyboard: 'Switch keyboard',
  /** Why the scary warning is safe to accept. */
  privacyTitle: 'About the warning',
  privacyIos:
    'iPhone warns that a keyboard with Full Access could send what you type. The HandsFreeOS keyboard never saves or sends anything you type. Full Access only lets it read the templates and links this app keeps for it.',
  privacyAndroid:
    'Android warns that a keyboard could collect what you type. The HandsFreeOS keyboard never saves or sends anything you type. It only shows the templates and links this app keeps for it.',
  onItTitle: 'On the keyboard',
  /** "12 templates and 5 links from Lone Star HVAC". */
  onIt: (templates: number, links: number, business: string): string =>
    `${templates} template${templates === 1 ? '' : 's'} and ${links} link${links === 1 ? '' : 's'} from ${business}`,
  nothingYet: 'Nothing yet. It fills in the first time this app has signal.',
  /** "Updated 2 minutes ago". */
  updated: (when: string): string => `Updated ${when}`,
  update: 'Update now',
  updating: 'Updating…',
  updatedToast: 'The keyboard is up to date.',
  /** The templates couldn't be fetched: no signal, or the person can't use the inbox here. */
  templatesNeedSignal:
    'Couldn’t get your templates with no signal. Try again when you have signal.',
  templatesNotYours:
    'Templates are for people who can use the Inbox here, so the keyboard shows links only. Ask an owner of this business if you need them.',
  otherBusinesses:
    'It holds each business you open in this app on this phone. Tap the business’s name on the keyboard to switch.',
} as const;
