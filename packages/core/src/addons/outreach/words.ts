/**
 * Social Outreach's words that the web and the phone both say and core doesn't say already, once, so the two never
 * drift (docs/outreach.md, decision 44). Each screen reuses core's own words first: Waiting for you's
 * (./waiting-words.ts), the live view's (./live.ts), the settings' (./automation.ts), Today's (./today.ts), the
 * groups' (./groups.ts), the chats' (./chat-read.ts) and the playbooks' (./playbooks.ts). Some are only the phone's
 * so far (its More row, what needs signal, and what waits there to be sent).
 *
 * Plain words, short sentences, curly apostrophes. Browser-safe and pure.
 */
import { CLIENT_CAUSE_WORDS, CLIENT_TAG, type ClientCause } from '../../crm/record-words';
import { clockWords } from './live';
import type { PushMode } from './automation';
import { DONT_PITCH_TAG } from './limits';
import { READ_CHATS_WORDS } from './asks';
import type { ChatView } from './chat-read';
import type { GroupView } from './groups';
import {
  FIND_WORDS_PARTS,
  FIND_WORDS_PER_DAY,
  forPartners,
  type FindWordsPart,
  type PlaybookDetails,
  type WordsPlatform,
} from './playbooks';

/** An empty list's title and what fills it. */
interface Empty {
  readonly title: string;
  readonly body: string;
}
const SAVE_GROUPS_FIRST =
  'Press Save my groups, and your computer saves the groups you’re in from Facebook. Or Find groups with a playbook’s words.';

/** One of the person's computers: the one that works, another open one, or one signed out (the web's list too). */
const COMPUTER_STATES = {
  working: 'Working for you',
  standingBy: 'Standing by',
  signedOut: 'Signed out',
} as const;

const SENDING_OFF = 'The extension doesn’t work on its own for you: you do everything.';
const ASK_TO_SEND = 'Ask an owner of this business if you’d like it to.';
const ALLOW_FOR_TEAM_IN = 'Your business doesn’t allow it yet. Allow it for your team in';
const SETTINGS_GENERAL = 'Settings → General';

const JOINED = 'You’re in it';
const TEAM_NONE = 'Nobody uses Social Outreach here yet';
const LIST_TODAY = 'Your list for today';
/** What waits for the person (decision 42), on Today since decision 59: the panel and the phone say it too. */
const NEEDS_YOU = 'Needs you';
const TODAY_EMPTY = 'Nothing on your list for today';

const days = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** The day someone on Later is back on Today (decision 100): "Nov 11", where the person is. */
const laterDay = (until: string) =>
  new Date(until).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const paceMessage = (n: number) =>
  n === 0
    ? 'First message the day they accept'
    : `First message ${days(n, 'day', 'days')} after they accept`;
const paceFollowUp = (n: number) =>
  `${days(n, 'follow-up', 'follow-ups')} until they answer, then a check-in each month`;

const things = (n: number, one: string, many: string) =>
  n === 1 ? `1 ${one}` : `${n.toLocaleString('en-US')} ${many}`;

export const OUTREACH_WORDS = {
  // ---- More, and the add-on's first screen ----
  title: 'Social Outreach',
  /** The More row's line, from the messages the phone keeps. */
  waitingMore: (messages: number) =>
    messages > 0
      ? `${things(messages, 'message waits', 'messages wait')} for your OK`
      : 'No messages wait for your OK',
  rows: {
    waiting: NEEDS_YOU,
    live: 'Live',
    today: 'Today',
    pipeline: 'Pipeline',
    groups: 'Groups',
    chats: 'Chats',
    never_contact: 'Never contact',
    partners: 'Partners',
    playbooks: 'Playbooks',
    settings: 'Settings',
    activity: 'Activity',
    friends: 'Friends',
  },
  rowDetails: {
    live: 'What your extension is doing, and Start my day',
    today: LIST_TODAY,
    pipeline: 'Everyone you reached, by where they stand',
    groups: 'Groups to work, and why',
    chats: 'Your chats, read by the AI',
    playbooks: 'Who you’re looking for, and how you sound',
    settings: 'What the extension does, and when',
  },
  /** A tab the phone leaves to the web. */
  onTheWeb: 'On the web',
  webOnlyTitle: (what: string) => `${what} is on the web`,
  webOnlyBody: 'This tab has a lot to look through, so it stays on the web. Open it there.',
  openOnTheWeb: 'Open on the web',

  // ---- Signal ----
  /** A screen that needs HandsFreeOS, with no signal. */
  needsSignal: (screen: string) => `${screen} needs signal. Try again when you’re back online.`,
  /** Under Waiting for you with no signal. */
  waitingOffline:
    'With no signal you see the messages waiting for your OK, and OK, change or skip them. Steps it needs you for and friend requests show when you’re back online.',
  /** Under something pressed with no signal. */
  queued: 'It goes when you’re back online.',
  /** The answer on screen is the last one asked: "As of 2:14 PM". */
  asOf: (at: number, timeZone: string) => `As of ${clockWords(at, timeZone)}`,
  tryAgain: 'Try again',

  // ---- Waiting for you ----
  emptyTitle: 'Nothing waits for you',
  emptyBody:
    'When the extension writes a message for your OK, hands you a reply, or can’t do a step, it shows here, and on its icon on your computer.',
  repliesNote: 'They need you, so each waits for an OK of its own: Approve all leaves them.',
  handedOver: 'Handed over',
  ok: 'OK',
  change: 'Change',
  skip: 'Skip',
  /** The sheet for changing a message before the OK. */
  changeTitle: (name: string) => `Message to ${name}`,
  changeHelp: 'Change it if you like; your changes teach the AI.',
  okChanged: 'OK and send',
  okd: 'OK’d. The extension sends it in Messenger, at a person’s pace.',
  /** Approve all's: with comments among them (decision 92), the messages go and the comments are posted. */
  okdAll: (n: number, comments = false) =>
    comments
      ? `OK’d ${things(n, 'message or comment', 'messages and comments')}. The extension sends and posts them, at a person’s pace.`
      : `OK’d ${things(n, 'message', 'messages')}. The extension sends them in Messenger, at a person’s pace.`,
  skipped: 'Skipped. They’re off your list for today.',
  /**
   * A comment on a good post waiting for the person's OK (decision 92): it goes under the post, on the network it's
   * on, once OK'd; skipped, the post is put aside so it's never offered again.
   */
  yourComment: 'Your comment',
  commentWaiting: 'I’d post this comment. Change it if you like; your changes teach the AI.',
  commentOkd: 'OK’d: the extension posts it soon.',
  okdComment: (network: string) =>
    `OK’d. The extension posts it under the post on ${network}, at a person’s pace.`,
  commentSkipped: 'Skipped. That post is off your list, and gets no comment.',
  /** A press with no signal: it waits on the phone. */
  okdQueued:
    'OK’d. It goes to HandsFreeOS when you’re back online. If that takes over 30 minutes, the phone asks you first.',
  skippedQueued: 'Skipped. It goes to HandsFreeOS when you’re back online.',
  copy: 'Copy',
  copied: 'Copied. Paste it into Messenger.',
  openInMessenger: 'Open in Messenger',
  openOnFacebook: 'Open on Facebook',
  leaveIt: 'Leave it',
  left: (name: string) => `Left. ${name} is off this list until they ask again.`,
  /** Confirm and Delete on a request to decide (decision 136): the extension does it. */
  confirmRequest: 'Confirm',
  deleteRequest: 'Delete',
  confirming: (name: string) =>
    `Confirming. Your computer confirms ${name}’s request as it works through your day.`,
  deleting: (name: string) =>
    `Deleting. Your computer deletes ${name}’s request with its once-a-day jobs.`,
  asked: (when: string, mutual: number | null) =>
    `Asked ${when}${mutual ? ` · ${mutual.toLocaleString('en-US')} mutual` : ''}`,
  hearTitle: 'How you hear of it',
  hearOfIt: (pushes: PushMode) =>
    `${
      pushes === 'each'
        ? 'Your phone and the extension tell you of each new message and step as it comes.'
        : 'Your phone and the extension tell you of new messages and steps in one go, at most every 2 hours in your working hours.'
    } A reply handed over to you comes at once. Friend requests don’t: Facebook tells you of those.`,
  changeInSettings: 'Change it in Settings',

  // ---- The live view ----
  rightNow: 'Right now',
  startDay: 'Start my day',
  stopDay: 'Stop for today',
  started: (computerOpen: boolean) =>
    computerOpen
      ? 'Your day has started. Your computer starts within seconds.'
      : 'Your day has started. Your computer begins as soon as Chrome is open.',
  stopped: 'Stopped for today.',
  startQueued: 'Your day starts when you’re back online.',
  stopQueued: 'Your day stops when you’re back online.',
  noComputer:
    'Install the extension and sign in on your computer, and you’ll see here what it’s doing.',
  onComputer: (name: string, seen: string) => `On ${name} · seen ${seen}`,
  nextStep: (when: string) => `Next step: ${when}`,
  otherOpen: (name: string) => `${name} is open: open the panel there to work from it.`,
  computerStates: COMPUTER_STATES,
  /** Another of their computers, which stands by while one works. */
  otherComputer: (name: string, signedOut: boolean, seen: string) =>
    `${name} · ${signedOut ? COMPUTER_STATES.signedOut : COMPUTER_STATES.standingBy} · seen ${seen}`,
  /**
   * The note when the extension doesn't work on its own for them, in parts so the web can link Settings: their own
   * choice to change (`canSend`); else, when the business allows only Off, an owner or admin (`manages`) allows it for
   * the team on General, and anyone else asks one.
   */
  sendingOffNote: SENDING_OFF,
  changeThatIn: 'Change that in',
  askToSend: ASK_TO_SEND,
  allowForTeamIn: ALLOW_FOR_TEAM_IN,
  /** A Start my day refused with no words of its own kept (it never should be): what to try. */
  startRefused: 'Your day didn’t start. Try again in a minute.',
  settingsGeneral: SETTINGS_GENERAL,
  sendingOff: (canSend: boolean, manages = false) =>
    `${SENDING_OFF} ${
      canSend
        ? 'Change that in Settings.'
        : manages
          ? `${ALLOW_FOR_TEAM_IN} ${SETTINGS_GENERAL}.`
          : ASK_TO_SEND
    }`,
  todaySoFar: 'Today so far',
  countOf: (done: number, most: number) =>
    `${done.toLocaleString('en-US')} of ${most.toLocaleString('en-US')}`,
  waitingLink: (n: number) => `${NEEDS_YOU}: ${n.toLocaleString('en-US')}`,
  todaySteps: 'Today’s steps',
  noSteps: 'Nothing yet today.',
  team: 'Your team',
  teamNoneTitle: TEAM_NONE,
  teamNone: `${TEAM_NONE}.`,
  teamComputer: (name: string | null, seen: string | null) =>
    name ? `${name}${seen ? ` · ${seen}` : ''}` : 'No computer yet',
  teamWaiting: (n: number) => (n ? `${n.toLocaleString('en-US')} waiting` : 'Nothing waiting'),
  warned: 'Facebook warned them',
  renameOnTheWeb: 'Rename a computer on the web.',

  // ---- Today ----
  todayEmpty: `${TODAY_EMPTY}.`,
  todayEmptyTitle: TODAY_EMPTY,
  todayEmptyBody:
    'People who fit your playbooks, new friends to say hi to, friends to reconnect with, chats to follow up and posts worth a comment show here. Give it something to work with:',
  /** Today's empty list: the next steps, each where it's done (decision 59). */
  todayStart: [
    {
      to: 'groups',
      title: 'Save your groups',
      body: 'Your computer saves the groups you’re in, then who’s in the best ones.',
      button: 'Go to Groups',
    },
    {
      to: 'chats',
      title: 'Read your chats',
      body: 'The AI reads your Messenger chats and finds who fits.',
      button: 'Go to Chats',
    },
    {
      to: 'friends',
      title: 'Check your friends',
      body: 'It looks for good fits among the friends you already have.',
      button: 'Go to Friends',
    },
  ] as const,
  listTitle: LIST_TODAY,
  todayComputerOnly:
    'Drafting a message, copying an opener and the AI’s drafts are on your computer, beside Facebook.',
  doneOnItsOwn: 'Done on its own',
  /** A post asking for what the business offers (decision 49): first on Today, with a push. */
  asking: 'Asking for what you offer',
  askingAbout: 'Answer these first, while they’re fresh.',
  notForMe: 'Not for me',
  notForMeDone: 'Put aside. It won’t be on your list again.',
  /** The conversation's steps on Today (decisions 65 to 67). */
  copyLinkOnly: 'Copy the link only',
  linkCopied:
    'Copied your link for them. Paste it in Messenger: a booking through it counts by itself.',
  copyVideoLink: 'Copy the video link',
  videoCopied: 'Copied your video’s link. Paste it in Messenger.',
  /** The phone's Send the video: the computer drafts it. */
  videoNext: 'Your computer drafts it next, with your video’s link.',
  stopCheckIns: 'Stop checking in',
  checkInsStopped: (name: string) =>
    `No more check-ins to ${name}. They start again if you two talk again.`,
  wheelsTitle: 'On training wheels',
  wheelsNone: 'Nobody is on training wheels.',
  endNow: 'End now',
  wheelsEnded: (name: string) => `Training wheels ended for ${name}.`,
  sentWaiting: 'I’d send this. Change it if you like; your changes teach the AI.',
  sentOkd: 'OK’d: the extension sends it soon.',

  // ---- Names a screen says in passing: a link to Settings, Results' heading (the pages are ./pages.ts) ----
  tabs: {
    today: 'Today',
    people: 'People',
    groups: 'Groups',
    results: 'Results',
    settings: 'Settings',
  },
  /** Find people's two parts (decision 128): every way's card, and the groups' own list. */
  findParts: {
    ways: 'Every way',
    groups: 'Groups',
  },
  /** People's lists. */
  peopleParts: {
    pipeline: 'Pipeline',
    friends: 'Friends',
    chats: 'Chats',
    partners: 'Partners',
    never_contact: 'Never contact',
  },
  /** The business's Never contact list, on the phone's People tab as on the web's Friends tab. */
  neverContactList: {
    about:
      'Nobody here sends anyone on this list a friend request, like, comment or message, not even a reply, and their friend requests are never confirmed. Turn the switch off to take someone off.',
    empty: {
      title: 'Nobody on the Never contact list',
      body: 'Put someone on it from a chat’s Never contact switch, or from the menu beside their name on Today.',
    },
    added: (by: string | null, at: string | null) =>
      [
        by ? `Added by ${by}` : 'Added',
        at
          ? new Date(at).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })
          : null,
      ]
        .filter(Boolean)
        .join(' · '),
    noMatch: {
      title: 'Nobody by that name on the list',
      body: 'Check the spelling and look again.',
    },
    openFacebook: 'Facebook',
    /** Under the list with no signal: each row's switch waits for it, and its Facebook button doesn't. */
    needsSignal: 'Taking someone off Never contact needs signal. Opening their page works now.',
  },
  /** The Settings menu's parts under More; General and the networks are `SETTINGS_WORDS`' (decision 73). */
  settingsParts: {
    playbooks: 'Playbooks',
    computer: 'Your computer',
    team: 'Team',
    fresh: 'Start fresh',
  },
  needsYou: NEEDS_YOU,
  /** Nothing waits: said in a line on Today. */
  needsYouNone: 'Nothing needs you right now.',
  doneToday: 'Done today',
  /** Under Done today: its feed is every network's (decision 127). */
  doneTodayAbout: 'On every network, newest first.',
  /** Done today shows its first steps, then the rest in place. */
  doneTodayMore: (n: number) => `Show ${things(n, 'more step', 'more steps')}`,
  /** Today's one card for what to know: warnings, holds and notes, each a line (decision 127). */
  headsUp: 'Heads up',
  /** Today's line to Needs you, which has its own page (decision 127). */
  needsYouCount: (n: number) =>
    n === 1 ? '1 thing needs you.' : `${n.toLocaleString('en-US')} things need you.`,
  openNeedsYou: 'Open Needs you',
  /** Today's fold-out, in place of the notes that sat beside each tab. */
  howItWorks: 'How Social Outreach works',
  howItWorksSteps: [
    {
      title: 'It finds people.',
      body: 'It reads the groups you pick and saves the people who fit your playbooks.',
    },
    {
      title: 'It makes friends.',
      body: 'A few friend requests at a time, at a person’s pace, and a hello when they say yes.',
    },
    {
      title: 'You say when to pitch.',
      body: 'Anything with your demo link waits on Today for your OK, unless you let it go on its own.',
    },
  ] as const,
  /** The Results tab: from reached to booked. */
  results: {
    /** The phone's link to Results on the web, with the whole team's and the old Activity's tables. */
    onWeb: 'More on the web',
    headline: (demos: number) => things(demos, 'demo booked', 'demos booked'),
    from: (people: number) => `from ${things(people, 'person reached', 'people reached')}`,
    funnel: {
      people: 'Reached',
      chatsStarted: 'Chats started',
      replies: 'Wrote back',
      demos: 'Demos booked',
    },
    /** Under each step but the first: how many of the step before made it. */
    rate: (pct: number, of: string) => `${pct}% of ${of.toLowerCase()}`,
    along: 'Along the way',
  },

  // ---- Someone kept as a profile: the person menu on their name (decision 91), wherever the app shows them ----
  person: {
    menu: (name: string) => `More for ${name}`,
    /** What pressing the name does, for a screen reader (the name itself is the button's label). */
    nameHint: 'Opens everything about them: their page, Contacts, Client, Don’t pitch and more',
    /**
     * The person panel (decision 128): their name opens it, with the menu's actions at its top, then why they fit,
     * the chat so far, where they were found and every step.
     */
    panel: {
      about: 'Everything about them, and what you can do.',
      whyFit: 'Why they fit',
      intro: 'Their page says',
      mutual: (count: number) => (count === 1 ? '1 mutual friend' : `${count} mutual friends`),
      nextStep: 'Next step',
      theChat: 'The chat so far',
      noChat: 'No chat read yet.',
      foundIn: 'Found in',
      everyStep: 'Every step',
      noSteps: 'No steps yet.',
      moreSteps: (count: number) =>
        count === 1 ? '1 earlier step not shown' : `${count} earlier steps not shown`,
      /** Who wrote last in the chat, and when ("3 h ago"). */
      lastFrom: (fromMe: boolean, ago: string) =>
        `${fromMe ? 'You wrote last' : 'They wrote last'}, ${ago}`,
      /** The group a step came from. */
      fromGroup: (name: string | null) => `from ${name ?? 'a group'}`,
      aGroup: 'a group',
      showAll: (count: number) => `Show all ${count.toLocaleString('en-US')} steps`,
      showLatest: 'Show the latest only',
      close: 'Close',
    },
    /** While the menu asks where they stand (`outreach.profile.marks`). */
    loading: 'Checking where they stand…',
    /** The People tab's moves to another stage, in the menu after opening their page. */
    moveTo: 'Move to',
    addToContacts: 'Add to Contacts',
    inContacts: 'In Contacts',
    /** Mark as client (`outreach.client.set`): the Client tag on them in Contacts, and no more outreach. */
    markClient: 'Mark as client',
    notClient: 'Not a client after all',
    /**
     * Why they're a client, where the menu can't take it back: "A client in Contacts: they paid a bill"; with no cause
     * of their own, a profile kept under the same name as a client on the same network.
     */
    clientLine: (cause: ClientCause | null) =>
      cause
        ? `A client in Contacts: ${CLIENT_CAUSE_WORDS[cause]}`
        : 'Same name as a client in Contacts',
    clientDone: (name: string) =>
      `${name} is a client now. Nobody here sends them outreach, and their replies still come to Waiting for you.`,
    clientOff: (name: string) =>
      `${name} isn’t a client any more. Messages skipped when you marked them stay skipped.`,
    /**
     * Not a client after all, when they're still one: for Contacts' own reason, or, with none of their own, for the
     * same name on this network as a client in Contacts (`clientSetWords` in ./person-menu.ts picks).
     */
    clientStill: (name: string, cause: ClientCause | null) =>
      cause
        ? `The ${CLIENT_TAG} tag is off ${name}, but Contacts still counts them a client: ${CLIENT_CAUSE_WORDS[cause]}. To change that, open them in Contacts.`
        : `The ${CLIENT_TAG} tag is off ${name}, but they have the same name on this network as a client in Contacts, so Social Outreach still leaves them alone. To change that, open that client in Contacts.`,
    /** The refusal when the person can't add and edit customers (`outreach_client_needs_contacts`). */
    clientNeedsContacts: (name: string) =>
      `Marking ${name} a client tags them in Contacts, and you can’t add and edit customers in this business. Ask an owner of this business to mark them, or to turn on Add and edit customers for you.`,
    /**
     * The refusal of an outreach message to a client (`outreach_client`), by why they're one: the Client tag (take it
     * off in their menu), Contacts' own reason, or the same name as a client on the same network.
     */
    clientNoOutreach: (name: string, cause: ClientCause | null) =>
      `${name} is a client, so Social Outreach doesn’t send them outreach. Their replies still come to Waiting for you. ${
        cause === 'tagged'
          ? 'To reach out again, choose Not a client after all in their menu.'
          : cause
            ? `Contacts counts them a client because ${CLIENT_CAUSE_WORDS[cause]}: to reach out again, change that in Contacts.`
            : 'They have the same name on this network as a client in Contacts, so they’re left alone as the same person.'
      }`,
    demoBooked: 'Demo booked',
    notDemo: 'Not a demo after all',
    /** Potential partner (decision 130, `outreach.partner.potential`): onto the person's Partners list, and back off. */
    potentialPartner: 'Potential partner',
    notPartner: 'Not a partner after all',
    /** Why the AI's check thinks they look more like a partner, over the button. */
    partnerHint: (why: string) => `Looks more like a partner: ${why}`,
    potentialDone: (name: string) =>
      `${name} is on your Partners list now. They get partner messages from here: a like first, then the ask a day later, each waiting for your OK.`,
    potentialOff: (name: string) =>
      `${name} is off your Partners list, and back on customer messages where they were.`,
    /** Later (decision 100): off the person's own Today for 2 weeks (`LATER_DAYS`), then back. */
    later: 'Later: back in 2 weeks',
    notLater: (until: string) => `Take off Later (back ${laterDay(until)})`,
    laterDone: (name: string, until: string) =>
      `${name} is off your Today until ${laterDay(until)}. Their replies still come.`,
    laterOff: (name: string) => `${name} is back on your Today.`,
    dontPitch: 'Don’t pitch',
    notDontPitch: 'Take off Don’t pitch',
    neverContact: 'Never contact',
    notNeverContact: 'Take off Never contact',
    /** Who put them on a list, where only they or an owner or admin can take them off: "Riley Member put them on Never contact". */
    putOnBy: (list: string, by: string | null) => (by ? `${by} put them on ${list}` : `On ${list}`),
    /** Never pitched for their tag in Contacts, which only Contacts takes off. */
    taggedFamily: `Tagged ${DONT_PITCH_TAG} in Contacts, so never pitched`,
    /**
     * The menu with no signal, by what it can open now: their page, their chat, or nothing, when the list doesn't know
     * their page and where they stand can't be asked (`personMenuOfflineWords` in ./person-menu.ts picks).
     */
    needsSignal: (opens: 'page' | 'chat' | null) =>
      `Contacts, Client, Demo booked, Potential partner, Later, Don’t pitch and Never contact need signal. ${
        opens ? `Opening their ${opens} works now.` : 'Try again when you’re back online.'
      }`,
    /**
     * What each item in the person menu does, in a sentence or two: shown when the pointer rests on it on the web
     * (`HINT_DELAY_MS`), and when it's held on the phone. Who reached them first, and giving them to a teammate, are
     * `OWNER_WORDS.giveHint`'s.
     */
    hints: {
      openPage: 'Opens their own page, to look them over or do something there yourself.',
      openChat: 'Opens your chat with them, to read it or write to them yourself.',
      inContacts: 'Opens them in Contacts.',
      addToContacts:
        'Saves them as a customer in Contacts. If someone there has the same name, you pick whether it’s them first.',
      markClient:
        'Tags them Client in Contacts. Nobody here sends them outreach again, and their replies still come to you.',
      notClient:
        'Takes the Client tag off, so they can get outreach again. Messages skipped when you marked them stay skipped.',
      demoBooked:
        'For a demo they booked some other way than your demo link. It counts toward which first messages work.',
      notDemo: 'Takes back the demo you marked.',
      potentialPartner:
        'Puts them on your Partners list. They get partner messages instead: a like first, then the ask a day later, each waiting for your OK.',
      notPartner: 'Takes them off your Partners list, and back to customer messages.',
      later:
        'Takes them off your Today for 2 weeks, then they’re back on their own. Your messages to them waiting for an OK are skipped, and their replies still come.',
      notLater: 'Puts them back on your Today now.',
      dontPitch:
        'Stops outreach to them from anyone here: first messages, pitches and follow-ups. Replies to them still go.',
      notDontPitch: 'They can get outreach again.',
      neverContact:
        'Stops everything from anyone here: no messages, likes, comments or friend requests, not even replies.',
      notNeverContact: 'They can be reached again.',
      /** The Pipeline's moves, by `StageMark`. */
      moves: {
        ready: 'Today offers them a pitch next, with your demo link in the drafts.',
        pitched: 'Notes that you’ve already offered them a demo.',
        lost: 'Ends outreach to them for good. Their replies still come, and Back in play undoes it.',
        open: 'Clears your mark, so their stage goes back to what their chat says.',
      } as Readonly<Record<string, string>>,
    },
    /** Under the phone's person menu: holding an item shows its explainer, as the pointer resting on it does on the web. */
    holdForHint: 'Press and hold a button to see what it does.',
    /** Under a chat's own Don't pitch and Never contact switches with no signal. */
    switchesNeedSignal:
      'Don’t pitch and Never contact need signal. Try again when you’re back online.',
    added: (name: string) => `${name} is in Contacts now.`,
    already: (name: string) => `${name} was in Contacts already.`,
    tied: (name: string) => `${name} is tied to them in Contacts now.`,
    demoMarked: (name: string) => `Marked: ${name} booked a demo.`,
    demoUnmarked: 'Unmarked.',
    dontPitchDone: (name: string) => `${name} is on Don’t pitch. Nobody here sends them outreach.`,
    dontPitchOff: (name: string) => `${name} is off the Don’t pitch list.`,
    neverContactDone: (name: string) =>
      `${name} is on Never contact. Nobody here messages, likes, comments on or friends them, and their friend requests wait on Facebook.`,
    neverContactOff: (name: string) => `${name} is off the Never contact list.`,
    /** "Is this one of these?", before someone goes in Contacts with a name Contacts already has. */
    sameTitle: (name: string) => `Is ${name} one of these?`,
    sameAbout:
      'Contacts has someone with the same name. Tie them together, or add them as someone new.',
    itsThem: 'It’s them',
    addAsNew: 'Add as new',
    /** What tells two customers with one name apart: their email or phone, where they came from, and when. */
    sameDetail: (p: {
      readonly email: string | null;
      readonly phone: string | null;
      readonly source: string | null;
      readonly createdAt: string;
    }) =>
      [
        p.email,
        p.phone,
        p.source,
        `added ${new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
      ]
        .filter(Boolean)
        .join(' · '),
  },

  // ---- Groups and chats ----
  search: 'Search by name',
  more: 'Show more',
  /** A friend's Keep switch: never suggested for unfriending. */
  friendKeep: 'Keep: never suggest unfriending them',
  friendKeepLabel: (name: string) => `Keep ${name}: never suggest unfriending them`,
  /** The Groups tab with none to show, by which groups. */
  groupsEmpty: {
    work: {
      title: 'No groups to work yet',
      body: `${SAVE_GROUPS_FIRST} Groups that match a playbook’s words to search for groups show here.`,
    },
    maybe: {
      title: 'No maybes',
      body: 'Groups that match a little, or that are just big, show here.',
    },
    skip: {
      title: 'Nothing to skip',
      body: 'Groups that match none of your playbooks, or match who to skip, show here.',
    },
    all: { title: 'No groups saved yet', body: SAVE_GROUPS_FIRST },
  } satisfies Record<GroupView, Empty>,
  groupsNoMatch: { title: 'No groups like that here', body: 'Check the spelling and look again.' },
  groupMembers: (n: number) => things(n, 'member', 'members'),
  joined: JOINED,
  notJoined: 'Not joined',
  peopleSaved: (n: number) => `${things(n, 'person', 'people')} saved`,
  groupLine: (members: number | null, people: number, joined: boolean | null) =>
    [
      members !== null ? things(members, 'member', 'members') : null,
      people ? `${things(people, 'person', 'people')} saved` : null,
      joined ? JOINED : null,
    ]
      .filter(Boolean)
      .join(' · '),
  /** The Chats tab with none to show, by which chats. */
  chatsEmpty: {
    prospects: {
      title: 'No likely prospects yet',
      body: 'Press Read my chats, or bring in your Facebook file on the Friends tab. HandsFreeOS reads each chat’s latest messages and shows here the people who look like they fit your playbooks.',
    },
    tagged: {
      title: 'Nobody tagged yet',
      body: 'Chats get your playbooks’ tags when the messages show they fit. Add tags to a playbook to have them used.',
    },
    read: {
      title: 'No chats read yet',
      body: `Press Read my chats, or bring in your Facebook file on the Friends tab, and each chat is read for you. ${READ_CHATS_WORDS}`,
    },
    waiting: {
      title: 'Every chat is read',
      body: 'Chats wait here while they’re being read, or when they couldn’t be.',
    },
  } satisfies Record<ChatView, Empty>,
  chatsNoMatch: {
    title: 'No chats like that here',
    body: 'Check the spelling, or clear the tag and look again.',
  },
  allTags: 'All tags',
  inContacts: 'In Contacts',
  openCustomer: 'Open in Customers',
  nextStepLabel: 'Next step',
  /** On a group: people there who fit and haven't been reached (decision 48). */
  leftToReach: (n: number) =>
    `${n.toLocaleString('en-US')} ${n === 1 ? 'person' : 'people'} who fit left to reach`,

  // ---- Playbooks ----
  playbooksEmpty: 'No playbooks yet.',
  /** A link to a playbook this business doesn't have (another business's, or an old one). */
  playbookMissing: 'This playbook isn’t in this business. Pick one from Playbooks.',
  inUse: 'In use',
  archived: 'Archived',
  newPlaybook: 'New playbook',
  blank: 'Start blank',
  fromTemplate: (name: string) => `Start from ${name}`,
  archive: 'Archive',
  bringBack: 'Bring back',
  archivedDone: 'Archived. It’s off the extension’s list.',
  backDone: 'Back in use.',
  readOnly: 'An owner or admin of this business writes the playbooks.',
  aiOnTheWeb: 'AI help (Improve, Suggest more) is on the web.',
  saved: 'Saved.',
  savedForEveryone: 'Saved for everyone.',
  name: 'Name',
  empty: 'Nothing yet.',
  oneALine: 'One a line.',
  question: 'Question',
  answers: 'Answers',
  addQuestion: 'Add a question',
  addAnswer: 'Add an answer',
  remove: 'Take out',
  leadsTo: 'Then',
  addsTag: 'Adds the tag',
  theySay: 'They say',
  noTag: 'No tag',
  /** How fast, for the steps it takes: null for a step it doesn't (a first message, follow-ups). */
  pace: (messageAfterDays: number | null, followUps: number | null) => {
    const said = [
      messageAfterDays === null ? null : paceMessage(messageAfterDays),
      followUps === null ? null : paceFollowUp(followUps),
    ].filter(Boolean);
    return said.length ? `${said.join('. ')}.` : '';
  },
  messageAfter: 'First message, days after they accept',
  followUpAfter: 'Follow-ups before the monthly check-in',
  followUpGap: (n: number) => `Follow-up ${n}, quiet days after the last message`,
  playbookSections: {
    goal: 'Goal',
    offer: 'The offer and its link',
    audience: 'Who it’s for',
    signs: 'Signs they fit',
    skip: 'Who to skip',
    area: 'Where they are',
    networks: 'Networks',
    groupWords: 'Words to search for groups',
    steps: 'Steps it takes',
    pace: 'How fast',
    video: 'Short video',
    tone: 'How it sounds',
    samples: 'Sample messages',
    openers: 'How first messages open',
    questions: 'The conversation',
    avoid: 'Words to avoid',
    disclaimer: 'Disclaimer',
    tags: 'Tags',
    // Each network's own words on a customers' playbook (data version 8, decision 92), shown while it runs there.
    hashtags: 'Hashtags on Instagram',
    postSearches: 'Words to search LinkedIn’s posts with',
    businessKinds: 'Kinds of business to search for on Alignable',
    worksOnline: 'Clients online',
  },
  /**
   * Each network's own words on a customers' playbook (decision 92): written by the AI once, from who it's for and
   * their problem, while the list is empty, and the person's to change. An emptied list means that network looks at
   * nothing for it. Which one shows under a list is `findWordsHint`'s.
   */
  findWords: {
    written: (perDay: number) =>
      `The AI wrote these from who it’s for and their problem. Change any; it looks at ${perDay} a day, in turn.`,
    notYet:
      'While this list is empty, the AI writes it once from who it’s for and their problem. Any words you add are used instead.',
    own: 'These are your own words, so the AI won’t add to them. Empty the list and it writes its own.',
    none: {
      instagram: 'Instagram won’t look at hashtags for this playbook.',
      linkedin: 'LinkedIn won’t search posts for this playbook.',
      alignable: 'Alignable won’t search for businesses for this playbook.',
    } satisfies Record<WordsPlatform, string>,
    hashtagHint: 'Like austinroofing. Each is cleaned as people tag it: no #, no spaces.',
    /** A line typed that makes no hashtag: too short, too long, or no letter in it. */
    hashtagBad: (line: string) =>
      `“${line}” isn’t a hashtag anyone tags. Write one as people tag it, like austinroofing.`,
  },
  /** Whether the business works with a playbook's clients online (decision 92): where Alignable searches. */
  worksOnline: {
    label: 'You work with clients online',
    yes: 'You work with clients online, so Alignable searches anywhere.',
    no: 'You work with clients near you, so Alignable searches your own town.',
  },
  /**
   * On a partner playbook its words for groups find partners too (stage 4 of the partners plan): the computer searches
   * posts and people with them (`playbookSectionTitle`).
   */
  partnerGroupWords: 'Words to search for groups and partners',
  partnerGroupWordsHint:
    'Like “Austin homeowners”. Your computer searches posts and people with these to find partners, and groups too.',
  offerLabel: 'What you offer',
  linkLabel: 'Its link',
  openerStyles: 'Styles the AI opens with',
  ownOpeners: 'Your own openers, sent as written',
  /** Someone changed the playbook since the phone loaded it: the section is put on the newer one. */
  changedSince: 'Someone changed this playbook meanwhile. Your change went on top of theirs.',

  // ---- Settings ----
  settingsFor: 'Settings for',
  settingsOf: (name: string) => `Settings for ${name}`,
  notSetYet: ' (not set yet)',
  changedBy: (name: string) => `Changed by ${name}.`,
  sections: {
    onItsOwn: 'What it does on its own',
    replies: 'Replies',
    posting: 'Helpful posts',
    along: 'Along the way',
    extension: 'The extension',
    pushes: 'Your phone and the extension',
    when: 'When',
    allowed: 'What people may pick',
    limits: 'Daily limits for each person',
    defaults: 'Where a new person starts',
    contacts: 'Who from Facebook chats goes in Contacts',
    cancelAfter: 'Suggest cancelling friend requests after',
    foundChecks: 'People found by topic checked a day',
    morning: 'Morning push',
    weekly: 'Weekly report by email',
    countries: 'Which countries to reach',
  },
  abouts: {
    onItsOwn:
      'It keeps your daily limits, goes at a person’s pace, and stops for the day on any warning from Facebook.',
    repliesOff: 'Replies go out only while it writes messages: pick what it does on its own first.',
    posting:
      'Once a day the AI writes a post that helps the people in one of your groups, after reading its rules: never selling, never the same group twice in a week. Who puts it up?',
    replies:
      'A reply to someone who asks for you, sounds upset, or writes about a refund, a complaint or cancelling always waits for you, and your phone hears it.',
    extension:
      'What it does while you use Facebook yourself, on every computer you’re signed in on.',
    pushes: 'How you hear about messages and steps waiting for you, and your numbers.',
    pushesAlways: 'A reply handed over to you always comes at once.',
    /** Under the day's report. */
    weekReview: 'Your week’s review comes on Monday morning, on Results and in a push.',
    when: (timeZone: string) =>
      `On your business’s clock (${timeZone}), at random times spread over the hours.`,
    allowed:
      'Doing everything themselves, and every reply waiting, are always allowed. Someone whose choice you stop allowing steps back to the nearest one you do.',
    limits:
      'Up to the starting limits, which keep a Facebook account safe. Halved for someone’s first 2 weeks there, for a week after a warning, and on training wheels.',
    defaults: 'Until they save their own.',
    contacts:
      'Each chat brought in from Facebook is read for a summary and your playbooks’ tags, and shows on the Chats tab. This says who also goes in Contacts.',
    cancelAfter:
      'Requests nobody has answered by then show under Tidy up on the Friends tab, for you to tick.',
    foundChecks:
      'For each person, on Instagram, LinkedIn and Alignable: how many people found under your hashtags, phrases and searches the AI checks from their own page. Fewer is slower and safer. Halved on training wheels and for a week after a warning, and LinkedIn’s stay inside its 40 profiles read a day.',
    morning:
      'Each person who used the extension lately hears how many are on their list for today, in your business’s time zone.',
    weekly:
      'Each person who used the extension that week gets their friend requests, replies and demos, their best group and their best opener, on Monday at the morning push’s hour (8 AM when that’s off).',
    countries:
      'Where people live: a “Lives in” on their profile first, then a look at their profile and the friends you share. A “From” on its own, or the AI’s guess from their name, never skips anyone: they wait for that look. Anyone skipped is on the Friends tab’s Skipped for country list, where Unskip lets them through.',
    notOwner:
      'An owner or admin of this business sets the choices you may pick and your daily limits.',
  },
  ticks: {
    warmUp: [
      'Like one of their posts a day before each friend request',
      'Facebook trusts a request more after a like.',
    ],
    confirmRequests: [
      'Confirm friend requests from people who fit a playbook',
      'The rest wait for you.',
    ],
    collect: [
      'Once a day, first: check friend requests, save group members, find posts and read my chats',
      'These fill the list it works from. It checks your friends and groups for good fits too.',
    ],
    joinGroups: [
      'Join good groups when my groups run low',
      'When your groups have less than a week of people left to reach, it finds groups with your playbook’s words and asks to join up to 3 good ones a day, answering their questions from your playbook.',
    ],
    watchPosts: [
      'Look for new posts asking for what I offer, every hour or two',
      'In your working hours, it looks at the newest posts in your best groups. When one asks for what you offer, your phone hears at once and it goes to the top of your list.',
    ],
    noting: [
      'Note my steps on Facebook',
      'Friend requests, likes, comments and messages you send yourself count toward your day.',
    ],
    readChats: [
      'Read chats as I open them',
      'A chat you open in Messenger goes to the AI to read, for the Chats tab.',
    ],
    markPosts: [
      'Look for posts as I scroll a group',
      'Posts worth a comment go on your list for today.',
    ],
    dayReport: [
      'The day’s report',
      'A push at the end of your working hours with the day’s numbers: messages sent, yeses and calls booked, and how far you are from your target. Only on a day you sent something.',
    ],
    acceptedPush: [
      'When someone accepts',
      'A push when someone accepts your friend request, accepts your invitation on LinkedIn or Alignable, or follows you back on Instagram.',
    ],
  } as const,
  /** On the Add-ons page, which points to Social Outreach's own Settings tab. */
  addonsPage: {
    about:
      'Who from Facebook chats goes in Contacts, when friend requests are suggested for cancelling, the morning push, the weekly report, the choices people may pick, daily limits and where your team gets the extension.',
    open: 'Open Social Outreach settings',
    notOwner:
      'Owners and admins change these in Social Outreach → Settings, under For your team on General and on each network’s page.',
    /** On the Chats tab, beside who goes in Contacts. */
    changeContacts: 'Change it in Settings',
    contactsNotOwner: 'An owner or admin can change this in Settings → General.',
  },
  notAllowed: (choices: readonly string[]) =>
    `Your business doesn’t allow: ${choices.join('; ')}. An owner or admin can change that in Settings → General.`,
  from: 'From',
  to: 'to',
  usual: 'The usual choice.',
  weeks: (n: number) => (n === 1 ? '1 week' : `${n} weeks`),
  aDay: (n: number) => `${n.toLocaleString()} a day`,
  off: 'Off',
  save: 'Save',
  savedFollows: 'Saved. The extension follows it in a few seconds.',
} as const;

/** A playbook part's title, as the web and the phone show it: on a partner playbook its words for groups find partners. */
export function playbookSectionTitle(
  section: keyof typeof OUTREACH_WORDS.playbookSections,
  details: Pick<PlaybookDetails, 'goal'>,
): string {
  return section === 'groupWords' && forPartners(details)
    ? OUTREACH_WORDS.partnerGroupWords
    : OUTREACH_WORDS.playbookSections[section];
}

/**
 * What a network's own words on a customers' playbook say under them (decision 92), on the web and the phone, as
 * `wordsDue` decides what the AI writes: what it wrote; a list it wrote and the person emptied, which looks at nothing;
 * an empty list it hasn't written, which it fills while it stays empty; or the person's own words, which it never adds
 * to. `wordsWritten` is the server's, as saved.
 */
export function findWordsHint(
  details: Partial<Pick<PlaybookDetails, FindWordsPart | 'wordsWritten'>>,
  platform: WordsPlatform,
): string {
  const has = (details[FIND_WORDS_PARTS[platform]] ?? []).length > 0;
  if (details.wordsWritten?.includes(platform))
    return has
      ? OUTREACH_WORDS.findWords.written(FIND_WORDS_PER_DAY[platform])
      : OUTREACH_WORDS.findWords.none[platform];
  return has ? OUTREACH_WORDS.findWords.own : OUTREACH_WORDS.findWords.notYet;
}

/** A customer Add to Contacts offers first, from `outreach.lookup`'s `sameName`. */
export interface SameNamePerson {
  readonly personId: string;
  readonly name: string;
  readonly detail: string;
}

/**
 * The customers in Contacts with someone's name, to offer before Add to Contacts makes a second (the web's and the
 * phone's person menu). For someone kept as a profile, only those not saved with a Facebook profile yet: one who is has
 * a profile of their own, so is someone else.
 */
export function sameNamePeople(
  found: {
    readonly sameName: readonly {
      readonly people: readonly (Parameters<typeof OUTREACH_WORDS.person.sameDetail>[0] & {
        readonly personId: string;
        readonly name: string;
        readonly hasProfile: boolean;
      })[];
    }[];
  },
  { withoutProfile }: { readonly withoutProfile: boolean },
): SameNamePerson[] {
  return (found.sameName[0]?.people ?? [])
    .filter((p) => !withoutProfile || !p.hasProfile)
    .map((p) => ({
      personId: p.personId,
      name: p.name,
      detail: OUTREACH_WORDS.person.sameDetail(p),
    }));
}

/**
 * Starting Social Outreach fresh (docs/outreach.md, "Starting fresh"), on the Settings tab for owners: everything it
 * keeps for the business erased, and it comes back empty for its setup (`addon.start_fresh`).
 */
export const START_FRESH_WORDS = {
  title: 'Start fresh',
  about:
    'Erase everything in Social Outreach for the whole business and start again with its setup: everyone’s saved profiles and friends, chats, groups, playbooks, settings, messages waiting, and the steps noted. Customers in Contacts stay, with their history. This can’t be undone.',
  button: 'Start fresh…',
  confirmTitle: 'Erase everything in Social Outreach?',
  confirmAbout:
    'Social Outreach is uninstalled, all of its data is deleted, and it’s installed again, empty, in about a minute. Everyone’s computers forget what they kept for it too.',
  typeName: 'Type Social Outreach to confirm',
  yes: 'Erase everything and start fresh',
  started:
    'Starting fresh. Social Outreach comes back empty in about a minute, ready to set up again.',
} as const;
