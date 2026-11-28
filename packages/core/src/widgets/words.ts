/**
 * The home-screen widgets' words (docs/phone-widgets.md), in one place for the phone's Home-screen widgets screen and
 * for the widgets themselves. The widgets are native code (SwiftUI on iPhone) or drawn by the app's own code with no
 * screen (Android), and neither can ask for words of its own, so the app writes what each widget says into the copy
 * it keeps for them (`buildWidgetsData`). Only what a widget says before it has that copy (nobody signed in, an
 * iPhone not unlocked since it restarted) lives in the native code.
 */

/** Each widget as the phone's widget gallery lists it. app.json says the same, and a phone test checks they match. */
export const WIDGET_GALLERY = {
  myday: {
    name: 'My day',
    description: 'Your next appointments, what needs you, and quick buttons, all in one.',
  },
  today: { name: 'Today', description: 'Your appointments today and the tasks that are due.' },
  needs: { name: 'Needs you', description: 'New leads, replies and anything else waiting on you.' },
  quick: {
    name: 'Quick actions',
    description: 'Add a contact, snap a receipt, start an invoice or ask HandsFreeOS.',
  },
  money: { name: 'Money', description: 'What came in, and what you’re still owed.' },
  outreach: {
    name: 'Social Outreach',
    description: 'Today’s first messages against your goal, and replies waiting for your OK.',
  },
  ask: { name: 'Ask HandsFreeOS', description: 'One tap and talk to the Assistant.' },
  lock: { name: 'HandsFreeOS', description: 'Your next appointment and what needs you.' },
} as const;

export type WidgetKind = keyof typeof WIDGET_GALLERY;

export const WIDGET_WORDS = {
  today: 'Today',
  needs: 'Needs you',
  money: 'Money',
  quick: 'Quick actions',
  ask: 'Ask HandsFreeOS',
  askHint: 'Tap and talk',
  /** An appointment going on right now, in the time column. */
  now: 'Now',
  urgent: 'Urgent',
  nothingToday: 'Nothing else today',
  nothingNeeds: 'You’re all caught up',
  /** Under "Updated" on the larger widgets: when the app last wrote the copy. */
  updated: 'Updated',
  appointments: (n: number) => (n === 1 ? '1 appointment' : `${n} appointments`),
  needCount: (n: number) => (n === 1 ? '1 needs you' : `${n} need you`),
  more: (n: number) => `+${n} more`,
  tasksDue: (n: number) => (n === 1 ? '1 task due today' : `${n} tasks due today`),
  tasksOverdue: (due: number, late: number) =>
    `${due === 1 ? '1 task due' : `${due} tasks due`} · ${late} overdue`,
  /** The lock screen's one line, which never names anyone. */
  lockNext: (time: string, what: string) => `${time} · ${what}`,
  lockNothing: 'Nothing else today',
  appointment: 'Appointment',
  quickActions: {
    contact: 'Add contact',
    receipt: 'Snap receipt',
    invoice: 'New invoice',
    calendar: 'Calendar',
    tasks: 'Tasks',
    ask: 'Ask',
  },
  moneyParts: {
    owed: 'Owed',
    late: 'Late',
    inToday: 'In today',
    inWeek: 'Last 7 days',
    waiting: (n: number) => (n === 1 ? '1 invoice waiting' : `${n} invoices waiting`),
    nothingWaiting: 'Nothing waiting to be paid',
    lateNote: (n: number) => (n === 1 ? '1 is late' : `${n} are late`),
    notYours:
      'Only people who manage money see this. Ask an owner of this business if you need it.',
  },
  /** An add-on's widget while the add-on isn't on in the business, or the person can't use it there. */
  addonOff: (addon: string, business: string) =>
    `${addon} isn’t on for you in ${business}. Ask an owner of this business to turn it on in Add-ons.`,
} as const;

/** What a widget says with no copy to read. The native widgets hold the same words, for before the app writes any. */
export const WIDGET_EMPTY_WORDS = {
  signedOut: 'Open HandsFreeOS to see your day here.',
  locked: 'Unlock your phone to see HandsFreeOS.',
} as const;

/** The Home-screen widgets screen, under More → Settings → This phone. */
export const WIDGET_SCREEN_WORDS = {
  /** Its row in Settings → This phone. */
  row: 'Home-screen widgets',
  rowDetail: 'Your day, what needs you and quick buttons, on your home screen.',
  title: 'Home-screen widgets',
  intro:
    'Put HandsFreeOS on your home screen: your day, what needs you, money, Social Outreach and quick buttons, without opening the app.',
  howIphoneTitle: 'On an iPhone',
  howIphone: [
    'Touch and hold an empty spot on your home screen until the apps jiggle.',
    'Tap + (or Edit, then Add Widget) at the top.',
    'Search for HandsFreeOS, pick a widget and a size, then tap Add Widget.',
    'For the lock screen: touch and hold it, tap Customize, then Lock Screen, and add HandsFreeOS.',
  ],
  howAndroidTitle: 'On Android',
  howAndroid: [
    'Touch and hold an empty spot on your home screen.',
    'Tap Widgets, then find HandsFreeOS.',
    'Touch and hold a widget and drag it where you want it. Most can be resized.',
  ],
  kindsTitle: 'The widgets',
  hideNames: 'Hide names on widgets',
  hideNamesHelp:
    'Widgets show customers’ names, so anyone who sees your unlocked phone sees them too, even with Face ID on for the app. Turn this on to show what each thing is instead: “Hot lead”, “Duct cleaning”. The lock screen never shows names.',
  status: (business: string, at: string) => `Showing ${business}, updated ${at}.`,
  statusNone: 'Nothing on the widgets yet. They fill in once a business is open in the app.',
  updateNow: 'Update now',
  updating: 'Updating…',
  updatedToast: 'The widgets are up to date.',
  whenTitle: 'When they update',
  when: 'Each time you open HandsFreeOS and while it’s open, as things change. Appointments move along on their own through the day. A new lead or message shows the next time the app opens.',
  viewingAs:
    'You’re viewing as a teammate, so the widgets keep showing your own day. Stop viewing as them to update the widgets.',
} as const;
