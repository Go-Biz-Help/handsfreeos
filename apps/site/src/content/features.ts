/**
 * What the product actually does, section by section, for the features page.
 *
 * Every line here is something HandsFreeOS does today. If a feature is removed or changed,
 * change it here too — this file is the one place the claims live.
 */

export type FeatureSection = {
  readonly id: string;
  readonly nav: string;
  readonly title: string;
  readonly intro: string;
  readonly points: readonly string[];
};

export const featureSections: readonly FeatureSection[] = [
  {
    id: 'inbox',
    nav: 'Calls, texts and email',
    title: 'One number, and one inbox for everything said to your business',
    intro:
      'Texts, calls, voicemail, email and website chat land in the same place, in one thread per customer, and the whole team can see it.',
    points: [
      'Your own local or toll-free business number — or keep the number people already have for you.',
      'Calls ring the cell phones you nominate. Calling a customer back from the app shows your business number, not your personal one.',
      'A missed call turns into a text back within a minute, if you want one.',
      'Voicemail arrives typed out, so you can read it between jobs instead of listening to it.',
      'Business email at your own domain, with an address for each person, in the same inbox as the texts.',
      'Or keep the mailbox you have: a connected Outlook mailbox shows its email in the same thread. Gmail is coming soon.',
      'Branded texts, once your sender is approved: on phones that support them, your texts show your name, logo and colours, with buttons to confirm, reschedule or call.',
      'Website chat on your own site, answered in the same inbox.',
      'Registration with the carriers, which US business texting requires, is part of setting you up.',
      'Anyone on the team can pick up a conversation, and you can see who is on it.',
    ],
  },
  {
    id: 'ai',
    nav: 'AI teammate',
    title: 'An AI teammate that answers your customers — once it has earned it',
    intro:
      'One teammate per business, with a name you pick and wording you approve. It starts by drafting and waiting for you, and only sends on its own once a kind of reply has earned enough of your approvals.',
    points: [
      'Answers new leads by text, email and website chat, usually in seconds.',
      'Picks up the phone when you can’t: answers the call, asks what the job is and books it, in English or Spanish.',
      'Makes calls for you: calls back a missed call, calls to confirm tomorrow’s visit, and asks you before it calls about a quote. It always says it’s an AI.',
      'Asks the questions that qualify a job, then books it straight into the calendar.',
      'Finishes the job in the conversation: checks you cover their address, adds them to the waitlist, books repeat visits and looks up what they owe. Anything about money waits for you.',
      'Hands the conversation to a person the moment someone asks for one, sounds unhappy, or it is not sure.',
      'Prices stay locked until you turn them on. After that it can only quote a number exactly as you wrote it.',
      'It writes from a knowledge base you can read and edit: your services, your hours, your FAQs, and what a scan of your website found.',
      'Everything it sends sits in the thread with the reason it sent it, so you can see how it is doing.',
      'Tell it “not like that” on any reply and it keeps the lesson. It re-reads your website each week and asks you about questions it couldn’t answer.',
      'Keeps the records right as it goes: tags, names, emails, numbers and addresses filled in from what customers say.',
      'Spots what you promised a customer and by when, and tells you if it didn’t happen.',
      'Put it back to asking first at any time, for everything or just for prices.',
    ],
  },
  {
    id: 'assistant',
    nav: 'The Assistant',
    title: 'Ask for something in plain English, and watch it happen',
    intro:
      'A panel on every screen. It answers questions about your business from your real data, and it does the work too — always showing you exactly what it is about to change before it changes it.',
    points: [
      '“Who hasn’t paid me?” “Book Dale for Thursday morning.” “Text everyone whose service is due.” Type it, or say it out loud.',
      'It can do anything you can do in the app. It never deletes anything for good.',
      'Anything it is about to do arrives as a card: this is what I will send, to whom, and when. You say yes.',
      'It sets the business up by asking you questions, instead of you hunting through settings pages.',
      'It writes estimates, fills in customers, moves appointments and drafts replies for you to send.',
      'It knows what you are looking at, so “move this to Friday” means this one.',
    ],
  },
  {
    id: 'customers',
    nav: 'Customers',
    title: 'A customer record that fills itself in',
    intro:
      'Not a contact list you keep up to date. Every text, call, email, appointment, quote and invoice lands on the customer’s page by itself, in the order it happened, with your notes and photos beside it.',
    points: [
      'Leads move through a pipeline whose stages you decide, dragged from one to the next.',
      'Tasks with due dates, assigned to whoever is doing them.',
      'Notes, tags and the details that matter for your trade.',
      'Photos and files attached to the customer, not lost in a camera roll.',
      'New leads land in one place from your website forms, Zapier and other apps, and Indeed applicants.',
      'Track your own kinds of records, like vehicles, properties, pets or equipment, tied to the customer they belong to.',
      'One search box finds any customer, message, note, file, form answer or setting.',
      'Import from a spreadsheet in a few minutes.',
      'Everything updates live — what one person changes, everyone else sees without refreshing.',
    ],
  },
  {
    id: 'calendar',
    nav: 'Calendar',
    title: 'A calendar customers book themselves into, without double-booking anyone',
    intro:
      'One calendar that becomes what your business needs through its settings, rather than five different products.',
    points: [
      'Book a named person, round robin across the crew, weighted so the new guy gets fewer, first available, or everyone together on the big job.',
      'Let the customer choose who comes, or run a calendar with no staff at all, where the room, the bay or the machine is what gets booked.',
      'Services with their own length, price, travel buffer and questions to ask at booking.',
      'A public booking page per service, on your own web address, that works on a phone.',
      'Google and Outlook busy times respected both ways, so a dentist appointment blocks a job.',
      'Reminders by text and email before the visit, and a notice when someone is on the way.',
      'Deposits taken at the moment of booking, with the time held while they pay.',
      'A waitlist that offers a cancelled time to the next person waiting, on its own.',
      'Intake questions sent to a first-time customer as soon as they book.',
    ],
  },
  {
    id: 'money',
    nav: 'Getting paid',
    title: 'Quotes they approve with their name, invoices that chase themselves',
    intro:
      'Priced from a catalogue you keep, sent from your phone, paid on the customer’s own screen — into your account, not ours.',
    points: [
      'A catalogue of services and parts with your prices, so a quote is a few taps.',
      'Estimates the customer approves by typing their name, which is recorded with the time and the version they saw.',
      'Invoices with a payment link, paid by card through your own Stripe or Square account.',
      'Deposits at booking, and maintenance plans that bill themselves every month.',
      'Unpaid invoices are chased on a schedule you set, without anybody remembering to.',
      'Receipts go out on their own; refunds are two clicks from the same screen.',
      'HandsFreeOS never holds your money and takes no cut of it.',
    ],
  },
  {
    id: 'documents',
    nav: 'Documents to sign',
    title: 'Contracts signed on their phone, without a separate e-signature app',
    intro:
      'Turn the contract or agreement you already use into a template once, then send it to sign by text or email in a couple of taps.',
    points: [
      'Upload a PDF and mark where people sign, initial, date or fill something in. The AI suggests where each field goes.',
      'Send to one person or several, in the order they sign. Each gets their own link, with reminders until it’s done.',
      'Sign now, for a customer standing in front of you: hand them your phone or tablet.',
      'The signed copy is saved on the customer’s record and locked for good, and they can find it in their own portal.',
      'Send, follow and make templates from the phone app too.',
    ],
  },
  {
    id: 'video',
    nav: 'Video calls',
    title: 'Video calls with the notes already written',
    intro:
      'Meet a customer face to face without Zoom. They join from a link in their browser, with nothing to install or sign up for, and the AI writes up the call while you talk. We’re turning calls on business by business: ask, and we’ll switch yours on.',
    points: [
      'Start a call from a customer’s page or a conversation, or switch a phone call to video.',
      'Each online appointment gets its own call, with nothing to set up.',
      'Live captions for everyone on the call.',
      'After the call, a summary, tasks and a follow-up email wait on the customer’s record for your OK.',
      'Prefer Zoom or Google Meet? Booked meetings get their link on their own, and a Zoom transcript becomes notes the same way.',
    ],
  },
  {
    id: 'marketing',
    nav: 'Marketing',
    title: 'Bring in the next job, and the one after that',
    intro:
      'Campaigns, reviews, forms and funnels, written with the AI and sent from the same place your customers already are. Nothing goes out to a crowd until you approve it.',
    points: [
      'Text, email and call campaigns: say what it’s for in a line, and the AI writes each customer their own text.',
      'Review requests after a good job, and your Google and Facebook reviews answered from one place.',
      'Forms, surveys and quizzes, built by describing what you want. Every answer lands on the customer’s record.',
      'Funnels the AI runs: describe the steps you want people taken through, and it sends each message and moves them on.',
      'Video funnels: a short video, a few questions and a live booking, all on one page.',
      'An offer builder that helps turn “we do roofing” into an offer people say yes to.',
      'Your own web address on booking pages, forms and payment links, like go.yourbusiness.com.',
      'A nudge three days before a promotion ends, so you can extend it or send one last campaign.',
    ],
  },
  {
    id: 'workflows',
    nav: 'Follow-ups',
    title: 'The follow-ups you keep meaning to do, done without you',
    intro:
      'Something happens — a lead comes in, a call is missed, a job finishes, an invoice goes late — and the follow-up runs itself.',
    points: [
      'Ready-made ones to start from: speed to lead, missed-call text back, appointment follow-up and review, estimate follow-up, no-show rebook.',
      'Three ways to edit the same workflow: a list of steps, a canvas you draw, or a sentence you type and it builds.',
      'Steps can text, email, wait, create a task, or hand the whole thing to your AI teammate.',
      'AI steps read the reply and take the right branch — emergency, wants to book, has a question, something else.',
      'Any step can stop and ask a person to approve before it goes out.',
      'A review request that goes to a happy customer, and quietly does not go to an unhappy one.',
    ],
  },
  {
    id: 'action-center',
    nav: 'What needs you',
    title: 'Not a dashboard to check. A short list of what needs you.',
    intro:
      'Home is not a wall of charts to keep an eye on. It is only what needs a person today, in order, with the money affected at the top — the safe ones it has already handled.',
    points: [
      'The hot lead waiting eleven minutes, the quote about to go stale, the invoice ten days late.',
      'The safe ones — confirmations, gentle nudges — HandsFreeOS just handles, and tells you it did.',
      'Anything else: “Let HandsFreeOS handle” it, or do it yourself from the same card.',
      'Switch between what needs you and what needs anyone on the team.',
      'A morning email at 7 with today’s jobs and who to call, an evening one with the day in numbers, and an email straight away for the urgent ones.',
    ],
  },
  {
    id: 'mobile',
    nav: 'On the phone',
    title: 'The whole thing in the pocket of the person doing the work',
    intro:
      'An app for iPhone and Android where everything can be read and changed with no signal at all, and catches up when the bars come back.',
    points: [
      'Look up a customer, write a note, take photos, move a job or start an invoice in a basement.',
      'A text written with no signal sends itself within half an hour, or asks “still send?” if it has been longer.',
      'Notifications you can act on without opening the app.',
      'Face ID to unlock, and a code by email if you would rather not have a password.',
      'Safety check-ins for anyone working alone: if they don’t check out on time, someone is told. “I’m OK” works from the lock screen.',
    ],
  },
  {
    id: 'moving-in',
    nav: 'Moving in',
    title: 'Your customers and your history come with you',
    intro:
      'Moving off the system you use today is the part people dread, so it is built to be careful and reversible.',
    points: [
      'It counts everything before it moves anything, and tells you how sure it is of each count.',
      'The same customer arriving from two places is joined without ever guessing on a name.',
      'Old conversations and appointments keep the dates they really happened on.',
      'It can be taken back without touching anything you have changed since.',
      'Proven on GoHighLevel first, with more systems following — tell us what you are on and we will tell you where it stands.',
    ],
  },
];

/** The quieter promises underneath all of it. */
export const foundations = [
  {
    title: 'Three roles, and nothing fuzzy',
    body: 'Owner, Admin and Member. A Member does the work and cannot invite people or change your settings. It is enforced in the database itself, not just hidden in the screens.',
  },
  {
    title: 'Every change is recorded',
    body: 'Who did what, when, and what it changed — including everything the AI did. Nothing happens in this system that cannot be traced back.',
  },
  {
    title: 'Your data stays yours',
    body: 'Export your customers, conversations, appointments and money records whenever you want. Leaving is a thing you can actually do.',
  },
  {
    title: 'As many people as work there',
    body: 'No charge per person, so the whole crew can have it, from the owner to the newest tech.',
  },
  {
    title: 'Nothing is gone by accident',
    body: 'Deleted things wait 30 days in a Deleted bin before they are gone for good.',
  },
  {
    title: 'Several businesses, or an agency',
    body: 'Run several businesses or locations from one sign-in, each with its own number, calendar and books. An agency can share its workflows and knowledge with every client.',
  },
  {
    title: 'One business cannot see another',
    body: 'If you run several locations, each one’s data is separated where it is stored, not just in the app. The same is true of every other business on HandsFreeOS.',
  },
] as const;

export type AutomationGroup = {
  readonly title: string;
  readonly items: readonly { readonly label: string; readonly does: string }[];
};

/**
 * Every automation, in the words and order of Settings → Automations in the app. Copied from `AUTOMATIONS` and
 * `AUTOMATION_GROUP_TITLES` in packages/core/src/automations/catalog.ts (the site doesn't import the product's
 * code): when an automation is added, renamed or removed there, change it here too.
 */
export const automationGroups: readonly AutomationGroup[] = [
  {
    title: 'Leads and sales',
    items: [
      { label: 'New lead greeting', does: 'Texts a brand-new lead or form fill right away.' },
      {
        label: 'Call back a missed call',
        does: 'The AI calls back a customer whose call nobody answered, and says it’s an AI.',
      },
      {
        label: 'Hot lead alert',
        does: 'Flags a lead who looks ready to buy, so someone calls them first.',
      },
      {
        label: 'Unanswered-message alert',
        does: 'Flags a customer or new lead who has been waiting too long for a reply.',
      },
      {
        label: 'Follow-ups after silence',
        does: 'Nudges a customer who stops replying, on a schedule you choose.',
      },
      {
        label: 'Follow-ups when a lead never replied',
        does: 'Chases a new lead who never answered, written from what they put on the form.',
      },
      {
        label: 'Chase an offered time',
        does: 'Follows up sooner when a lead was offered times and went quiet.',
      },
      {
        label: 'Re-engage dead leads',
        does: 'Texts open leads nobody has been in touch with for months, in your words.',
      },
    ],
  },
  {
    title: 'Appointments',
    items: [
      {
        label: 'Day-before confirmation',
        does: 'Reminds the customer about tomorrow’s visit and asks them to confirm.',
      },
      {
        label: 'Day-of reminder',
        does: 'Reminds the customer a couple of hours before their visit.',
      },
      {
        label: 'Call to confirm tomorrow’s visit',
        does: 'The AI calls a customer who hasn’t confirmed tomorrow’s visit by text.',
      },
      {
        label: 'Unconfirmed visit alert',
        does: 'Flags upcoming visits the customer hasn’t confirmed, and asks them once more.',
      },
      {
        label: 'Intake questions',
        does: 'Sends a first-time customer your intake form right after they book.',
      },
      {
        label: 'Maintenance due',
        does: 'Texts a customer to rebook when their regular service comes round again.',
      },
      {
        label: 'Waitlist slot opened',
        does: 'Tells the next person waiting when a time in their window frees up.',
      },
    ],
  },
  {
    title: 'After the job',
    items: [
      {
        label: 'Thank-you after the job',
        does: 'Texts the customer a short thank-you two hours after a job is marked done.',
      },
      {
        label: 'Overdue invoices',
        does: 'Flags past-due invoices and writes the follow-up for you to send.',
      },
      {
        label: 'Referral mentioned',
        does: 'Flags a customer who mentions someone who needs you, so you can reach out.',
      },
    ],
  },
  {
    title: 'Daily briefings',
    items: [
      {
        label: 'Morning brief',
        does: 'An email at 7 AM with today’s jobs, who to call and what needs attention.',
      },
      {
        label: 'End-of-day email',
        does: 'An email at 6 PM with what’s still open and the day in numbers.',
      },
    ],
  },
  {
    title: 'Pipeline and records',
    items: [
      {
        label: 'Stale opportunities',
        does: 'Flags open deals nobody has been in touch with for a while.',
      },
      {
        label: 'Leads with no next step',
        does: 'Flags open leads with nothing planned, or a follow-up that’s overdue.',
      },
      {
        label: 'Quotes with no decision',
        does: 'Flags estimates with no yes or no, and writes the follow-up for you to send.',
      },
      {
        label: 'Call about a quote with no answer',
        does: 'Two days after a quote’s reminder, the AI asks to call them. A person approves each call.',
      },
      {
        label: 'Move deals along for you',
        does: 'Moves a deal to the right stage when a quote goes out, a visit is booked or they say yes.',
      },
      {
        label: 'Add people you’re talking with',
        does: 'Makes a deal for someone you’re really talking with who doesn’t have one yet.',
      },
      {
        label: 'Tag customers for you',
        does: 'The AI reads each new message, call, visit and payment and keeps the customer’s tags right.',
      },
      {
        label: 'Keep contact details up to date',
        does: 'Fills in or fixes a customer’s name, email, number or address when they tell you.',
      },
      {
        label: 'Deal in the wrong stage',
        does: 'Flags a deal whose stage is behind what happened, with a one-tap move.',
      },
      {
        label: 'Went quiet after a price',
        does: 'Flags a customer who heard a price two days ago and hasn’t replied.',
      },
      {
        label: 'Did the job happen?',
        does: 'Asks whoever was on a job how it went, 30 minutes after it ends.',
      },
      {
        label: 'Booked, never marked done',
        does: 'Flags a job nobody marked done three days after its time.',
      },
      {
        label: 'Job missing an address',
        does: 'Flags a job at the customer’s place with no address, two days before.',
      },
    ],
  },
  {
    title: 'Service and handoffs',
    items: [
      { label: 'Overdue tasks', does: 'Flags to-dos that are past their due time.' },
      {
        label: 'Hand-off nobody picked up',
        does: 'Pings them again at 1 hour when nobody took a hand-off, and tells the owner at 4.',
      },
      {
        label: 'Regular customer gone quiet',
        does: 'Flags a regular who hasn’t been back for twice their usual gap, so someone checks in.',
      },
      {
        label: 'Promises not kept',
        does: 'AI spots what you promised a customer and by when, and flags it if it didn’t happen.',
      },
      {
        label: 'Approvals about to expire',
        does: 'Makes a waiting approval urgent 2 hours before it expires, and pings who can decide.',
      },
    ],
  },
  {
    title: 'Marketing and content',
    items: [
      {
        label: 'Drafts awaiting review',
        does: 'Shows AI drafts and approvals waiting on someone to decide.',
      },
      {
        label: 'Promotion ending',
        does: 'Reminds you 3 days before a promotion ends, so you can extend it or send one last campaign.',
      },
    ],
  },
  {
    title: 'Ads and money',
    items: [
      { label: 'Balance running low', does: 'Warns you before your texting balance runs out.' },
      {
        label: 'Money in changed',
        does: 'On Monday, flags a week whose money in was 30% above or below usual, and why.',
      },
    ],
  },
  {
    title: 'Health and quality',
    items: [
      {
        label: 'Channel went quiet',
        does: 'Flags texts, calls, email or website chat when nothing has come in for 3 times the usual gap.',
      },
      {
        label: 'Connection broke',
        does: 'Tells you right away when payments, a calendar, email, reviews or a phone number stop working.',
      },
      {
        label: 'Texting turned down',
        does: 'Tells you when the phone carriers turn down your texting details, and why.',
      },
      {
        label: 'Connection went silent',
        does: 'Flags a calendar, inbox or reviews that stopped bringing anything in.',
      },
      {
        label: 'Nobody reviewing the AI',
        does: 'Flags it when nobody has checked the AI teammate’s work for 7 days.',
      },
      {
        label: 'Learn from corrections',
        does: 'When you fix the AI, suggests a line to teach it at once, and asks if it clashes with what it knows.',
      },
      {
        label: 'Website changed',
        does: 'Re-reads your website each week and shows what changed, so the AI’s answers stay right.',
      },
      {
        label: 'Questions the AI can’t answer',
        does: 'When customers ask the same thing 3 times and the AI couldn’t answer, asks you once.',
      },
    ],
  },
];

/** What is on its way, said plainly, so nothing above has to pretend. Move a line up into its section when it ships. */
export const comingSoon = [
  {
    title: 'Gmail',
    when: 'Waiting on Google’s review',
    body: 'Connect a Gmail mailbox the way Outlook works today.',
  },
  {
    title: 'Facebook and Instagram messages',
    when: 'Waiting on Meta’s review',
    body: 'DMs in the same inbox, with the ad that brought each one. Facebook lead ads come in through Zapier until then.',
  },
  {
    title: 'AI Sales Coach',
    when: 'In testing',
    body: 'Tells your rep what to say next during a call, then writes the notes, the follow-up and a score.',
  },
  {
    title: 'Social Outreach',
    when: 'In testing',
    body: 'A browser extension that finds and follows up with prospects on Facebook, Instagram, LinkedIn and Alignable.',
  },
  {
    title: 'Partners',
    when: 'In testing',
    body: 'Find people whose audience is your buyers, and pay them a share of what they bring.',
  },
  {
    title: 'Real Estate Agent add-on',
    when: 'In testing',
    body: 'Every duty and deadline on a home sale, tracked from offer to closing.',
  },
] as const;
