/**
 * Where the everyday work is (M12, alongside the settings map): every page that isn't a setting, the pages inside
 * them (a customer, a lead, an invoice, a workflow), what is on each, the "how do I…" people ask about them
 * answered as the clicks, and what people look for that isn't there. Browser-safe: the worker's prompt reads it and
 * a test reads it against the web app's menus.
 *
 * The words follow one rule so the Assistant can repeat them as they are: an arrow is a click on the side menu or a
 * row of tabs ("Money → Estimates"), and everything after that is said in words ("press the estimate, then They
 * said yes"). test/settings-map.test.ts checks every arrow here against those menus.
 */

import { PHONE_APP_LINKS } from '../onboarding/app-links';

export interface AppPlace {
  /** What it is called: the side menu's word, or what it is ("A customer’s page"). */
  readonly label: string;
  readonly what: string;
  /** The way there through the side menu and tabs; empty when it isn't in the side menu (the agency area). */
  readonly where: readonly string[];
  /** What to press after that when it isn't a menu or a tab: "press the person". */
  readonly then?: string;
  /** What is on it, top to bottom, each part as the screen heads it. */
  readonly onScreen: readonly string[];
  /** "How do I…", each answered as the clicks. */
  readonly howTo: readonly string[];
  /** What the Assistant can do here itself, on a card the person confirms. */
  readonly canChange?: readonly string[];
  /** What people look for here that HandsFreeOS doesn't do, so the Assistant says so rather than invent a button. */
  readonly notHere?: readonly string[];
  /** The screen, under /app/w/<workspaceId> (under /app/org/<orgId> for the agency area). */
  readonly path: string;
  /**
   * The `?view=` its address keeps, when one page holds several places as tabs (AI Sales Coach's Coached, Trends and
   * Playbooks): it is the screen only when the address's view is this one, and the place on the same page without a
   * view is otherwise.
   */
  readonly view?: string;
  /**
   * What an id in its address's query holds, by the query's key, when the key alone doesn't say and means that only
   * here (an add-on's Settings opening a teammate's at `?for=<their user id>`: `{ for: 'user' }`).
   */
  readonly queryIds?: Readonly<Record<string, string>>;
}

export const APP_PLACES: readonly AppPlace[] = [
  {
    label: 'Home',
    what: 'the Action Center: one list of what needs attention, most urgent first',
    where: ['Home'],
    onScreen: [
      'Mine or Everyone, and New lead (it opens Pipeline)',
      'Urgent and Up next; each item has its own button (Reply, Call, Approve, Set next action, Open the invoice…), Let HandsFreeOS Handle, and ⋯ with Assign…, Snooze (1 hour, This evening, Tomorrow morning, Next week, Pick a time…) and Dismiss…',
      'Handled by HandsFreeOS',
      'Beside the list: Today (Open calendar, today’s visits, Tasks due today) and Coming up from HandsFreeOS, each with Cancel',
      'Getting started at the top until the person finishes or hides it: for owners and admins the business’s steps (The basics, then When you’re ready), each with its own button and Skip; for everyone else Get set up, their own short list; and Hide guide',
      'Above the steps, until the business’s guided setup is finished: Set up your business with Start, Finish setting up your business with Carry on once it’s started, or, for an owner whose agency set it up, “<agency> set up your business” with Check it and finish; Take the tour, until it’s taken or skipped',
    ],
    howTo: [
      'Let HandsFreeOS deal with an item: press Let HandsFreeOS Handle on it',
      'Put off a setup step: Skip on its row in Getting started; Undo brings it back',
      'Bring Getting started back after hiding it: Get help at the foot of the menu, then Getting started',
      'Take the tour of the menu again: Get help at the foot of the menu, then Take the tour (while Getting started isn’t finished), or Take the tour on Getting started',
      'Turn Getting started off for everyone in the business (owners and admins): Settings → Workspace, Getting started guide; the same switch turns it back on',
      'Put an item off: its ⋯, then Snooze and a time (Pick a time… for an exact one)',
      'Give an item to someone: its ⋯, then Assign…',
      'Clear an item: its ⋯, then Dismiss…; the note that pops up has Undo',
      'Stop a follow-up HandsFreeOS is about to send: Cancel on the blue strip on the item, or in Coming up from HandsFreeOS',
      'Chase an overdue invoice: its item on Home, Email, Text or Call (what counts as overdue is Settings → Automations, Overdue invoices)',
      'Tick off a task due today: Today, press the circle beside it',
    ],
    notHere: ['snoozing or dismissing many items at once', 'filtering the list by kind'],
    path: '',
  },
  {
    label: 'Set up your business',
    what: 'the guided setup a new business goes through, simple questions a screen at a time, about 15 minutes; the answers are kept as it goes, so it carries on later, here or in the phone app, and nothing but the screens that act at once changes until Stay in the loop saves it all',
    where: ['Home'],
    then: 'press Start on Set up your business at the top of Getting started (Carry on once it’s started, or Check it and finish for an owner whose agency set it up)',
    onScreen: [
      'At the top, where it’s up to (“3 of 15”) and the stop’s name; Next and Back on each screen, and Skip for now on the ones that can wait',
      'The stops: Your business (name, kind of business, the address, which sets the time zone, and the website, which the AI teammate starts reading), Your goal (What do you want help with first? and How many people work with you?, with Invite them now), About your business, Your hours, Your logo and colour, Your page (only with no website), Your customers, Your booking page (only when customers book a time), Your business number (search near the business, by area code or anywhere, then pick one), Payments and reviews, Your AI teammate (several screens), Stay in the loop (Save; with an AI teammate already, what will change, then Save these changes), Try it, and Done',
      'Carry on where you left off, Start over, and See the summary (Your setup so far)',
      'Someone from the business’s agency setting it up for the owner gets Hand it over in place of Stay in the loop, with Save and hand it over: the owner is emailed to check it and finish their part (the booking page, payments and their notifications); the owner then sees what was set up, with Change something and Finish my part',
    ],
    howTo: [
      'Carry on where they left off: Home, then Carry on on Getting started; on the phone, Home, then Carry on on Getting started too',
      'Change an answer once it’s finished: each one lives on its own settings page, like Settings → Workspace for the business and its hours, Settings → Calendars for booking, Settings → Texting & calls for the number and Settings → Payments for getting paid',
    ],
    canChange: [
      'read where it’s up to, the screens left and what saving would change',
      'save a screen’s answers, or save it all, on a card that says what will change; only the answers they give change',
      'look for a business number near the business, by area code or toll-free, and get the one they pick',
    ],
    notHere: [
      'signing up, connecting payments, uploading the logo or confirming their cell for them: those are theirs to do on the screen',
    ],
    path: '/onboarding/[workspaceId]',
  },
  {
    label: 'A setup step',
    what: 'one of the basics Getting started opens on a screen of its own: the business number, payments, customers, the calendar and booking page, and the AI teammate',
    where: ['Home'],
    then: 'press the step’s own button on Getting started',
    onScreen: [
      'Setting up <business>, with The basics down the side (About 20 minutes. Skip anything and come back to it from Home.) and Finish later',
      'Back, Skip for now and Continue; the last one says Finish and see Home',
    ],
    howTo: ['Come back to a step skipped here: Home, then its button on Getting started'],
    path: '/onboarding/[workspaceId]/setup/[step]',
  },
  {
    label: 'Inbox',
    what: 'every conversation with customers: texts, calls, email, website chat, a client’s portal messages, and Messenger and Instagram direct messages',
    where: ['Inbox'],
    onScreen: [
      'New message, at the top (it starts a text to someone already in Contacts)',
      'Mine, Unassigned, and All (Everyone when each person sees only their own); Needs a person and the AI teammate’s own box when it is on',
      'My mail, the person’s own connected Gmail or Outlook (only they see it), with its own Inbox, and the team’s Other mail and Spam for email from people not in Contacts',
      'Unread, to show only conversations with something unread',
      'Search conversations (names, numbers and words in messages; Search everything at the top of the side menu finds them too), and Open, Snoozed, Closed or Archived',
      'Select, for whoever may delete for good (owners, unless one gives it out): tick conversations, then Delete for good…',
    ],
    howTo: [
      'Text a customer who hasn’t written in: Inbox, press New message, pick them in To, then Open conversation',
      'Email someone new: open their page in Contacts and press Email (New message only starts texts)',
      'Find an archived conversation: Inbox, then Archived in the status picker',
      'See what the AI teammate handed over: Inbox, Needs a person',
      'Find email from someone new: Inbox, then Other mail (or Spam)',
      'Delete several conversations for good: Inbox, press Select, tick them, then Delete for good… (they wait 30 days in Settings → Deleted bin)',
    ],
    canChange: [
      'find closed, snoozed, archived, Needs a person and AI-teammate conversations, unread ones, your own mail, Other mail and Spam',
    ],
    path: '/inbox',
  },
  {
    label: 'A conversation',
    what: 'one customer’s texts, calls and emails (or their website chat, portal, Messenger or Instagram messages), the reply box, and their details beside it',
    where: ['Inbox'],
    then: 'press the conversation',
    onScreen: [
      'At the top: which line to answer on, Assign, Snooze, Close (or Reopen), Customer details, and ⋯ with Call, Video call, Open customer (or Add as a new person), Hand to (the AI teammate’s name), Mark as unread, Close every line, Copy phone number, Copy email address, Archive this conversation, and Delete for good… (owners)',
      'On an email: Move to Inbox, Move to Other mail, Move to Spam (or Not spam), and Always put their mail in the Inbox, Other mail or Spam; on your own mail, Share with the team',
      'Banners when the AI teammate has it: Take over, Take it, or Hand back',
      'The AI teammate’s drafts in the thread: Approve and send, Edit, Reject…',
      'The reply box: Text or Email, Cc and Subject for email, the paperclip for a photo or file, Insert a template, Add buttons or a card, Ask for a video (texts only), then Send text or Send email; in quiet hours it offers Send at the time they end',
      'A call in the thread: its recording and words, and Notes from the call; while you’re on a call, Switch to video on the call bar',
      'Beside it: their name, number, email and tags (press one to change it), Call, Open customer, Edit all details, Open lead (its stage, Set next action, or Start one), Add a note, Open tasks (Add task), Next visits (Book a visit), and Money (New estimate, New invoice)',
      'For a number that isn’t a customer: Add customer, or Or link to an existing customer',
    ],
    howTo: [
      'Reply by email instead of text: in the reply box, switch Text to Email',
      'Send a photo: the paperclip in the reply box (the conversation needs to be a customer)',
      'Use a saved template: Insert a template beside the paperclip, then pick one; the customer’s name goes in for them, and anything it can’t fill is left to type',
      'Leave a note only the team sees: Add a note beside the conversation, then Add note',
      'Give a conversation to someone: Assign at the top',
      'Give it to the AI teammate: ⋯, then Hand to (its name); take it back with Take over',
      'Start a video call with them: ⋯, then Video call (their link goes by text or email, and the call opens for you)',
      'Ask them for a video: Ask for a video in the reply box, then Send text',
      'Move an email to Other mail or Spam: ⋯, then Move to Other mail or Move to Spam; Always put their mail… does it for their next ones too',
      'Save a stranger as a customer: type their name beside the conversation and press Add customer, or link them to an existing one',
      'Move their lead’s stage, book them, add a task or quote them: in the panel beside the conversation',
      'Mark it unread: ⋯, then Mark as unread',
      'Archive it: ⋯, then Archive this conversation (Bring it back undoes it)',
      'Delete it for good: ⋯, then Delete for good… (owners); the customer stays in Contacts, and it waits 30 days in Settings → Deleted bin',
    ],
    notHere: [
      'sending later, except after quiet hours',
      'an AI rewrite button, emoji or formatting',
      'a note inside the reply box (notes go in Add a note beside it)',
    ],
    canChange: [
      'assign it to a teammate or nobody; close, reopen or snooze it; mark it read or unread',
      'hand it to the AI teammate or take it back',
      'link a conversation from an unknown number or address to a customer',
      'cancel a text waiting for quiet hours, or send again a text or email that didn’t go out',
      'archive it and bring it back (owners and admins)',
      'reply in a website chat, portal, Messenger or Instagram conversation',
      'start a video call with them, or ask them for a video in a text',
      'move an email to Other mail or Spam, or always put their mail there; share your own mail with the team; close every line with them',
    ],
    path: '/inbox/[conversationId]',
  },
  {
    label: 'Contacts',
    what: 'people, companies and the business’s own kinds of records: leads and clients alike',
    where: ['Contacts'],
    onScreen: [
      'Tabs: People, Companies, and any kinds of records of your own',
      'Import and Add person (Add company on Companies), at the top',
      'Search by name, phone, email or street; All, Leads or Clients; Any tag; Assigned to anyone; Show archived',
      'A Client badge beside each client’s name',
      'A tick box beside each person, for whoever may delete for good (owners, unless one gives it out), and Delete for good… once some are ticked',
    ],
    howTo: [
      'Add a customer: Contacts, press Add person, then Save person (it warns when they may already be there)',
      'Add a company: Contacts → Companies, press Add company',
      'Import a spreadsheet: Contacts, press Import (the same as Settings → Imports)',
      'See only leads or only clients: Contacts, then Leads or Clients beside the search (a client has a won lead, a job underway or done, a visit they came to, a plan they’re on, or a paid bill; everyone else is a lead)',
      'Find everyone with a tag: Contacts, then Any tag',
      'Bring back an archived customer: Contacts, Show archived, press them, then ⋯ and Restore',
      'Delete customers for good: Contacts, tick them, then Delete for good… (owners); they wait 30 days in Settings → Deleted bin',
      'Bring back a deleted customer, conversation or booking: Settings → Deleted bin, then Bring back',
      'Search from anywhere: Search everything at the top of the side menu (⌘K or Ctrl K) finds customers by name, phone, email or street, and archived ones under Archived',
    ],
    notHere: [
      'choosing many customers at once to tag, assign or archive (the Assistant can tag many at once)',
      'exporting customers to a spreadsheet',
    ],
    canChange: [
      'add a company and change its details',
      'archive and bring back a customer or company (owners and admins)',
      'merge two records for the same customer into one (owners and admins)',
      'find archived customers, companies, leads and records',
    ],
    path: '/customers',
  },
  {
    label: 'A customer’s page',
    what: 'one person: everything the business has done with them',
    where: ['Contacts'],
    then: 'press the person',
    onScreen: [
      'At the top: their tags (Add tag, or + to change them), and ⋯ with Edit details, Merge…, Archive and Delete for good… (owners)',
      'Along the top: Call, Text, Email (with a choice of number or email when they have more than one), Video call, Book, Note, Log call, Task, Lead, File, Document (for whoever may send documents), and Add to workflow…',
      'Tabs: Timeline, Appointments, Money, Leads, Tasks, Files, Details (Details has Edit, Calls from us, and their Fields)',
      'Beside them: Assigned to, Upcoming appointments, Regular services, Conversations, Where they came from (the ads and links that brought them, when any did), Partner (while partners are on), Workflows, Open lead, Relationships',
      'Under their name, while the business has funnels: the funnel they’re in, its stage and what it sends next, with Pause or Resume, Move to and Remove from (the funnel); a suggestion from the AI teammate asks Yes, put them in or No; in none, Add to a funnel',
    ],
    howTo: [
      'Tag them: their page, Add tag (or + beside their tags), then press a tag or New tag',
      'Change their name, number, email or address: their page, ⋯, Edit details; Add another number adds a second one',
      'Fill in a field of your own: their page, Details tab, Edit beside Fields',
      'Book them in: their page, press Book',
      'Log a call, visit or note: their page, Note or Log call',
      'Open a lead for them: their page, press Lead',
      'Add a task for them: their page, press Task, then New task',
      'Upload a photo or file: their page, press File, then Choose file',
      'Remove a file: their page, Files tab, ⋯ beside the file, then Remove (for whoever may delete files); it’s gone for good, so they press it themselves, and a signed one can’t be removed',
      'Send them a document to sign: their page, press Document',
      'Start a video call with them: their page, press Video call; the link goes by text or email',
      'Write them an estimate or invoice: their page, Money tab, New estimate or New invoice',
      'Put them on a maintenance plan: their page, Money tab, Put on a plan',
      'Put them on a workflow: their page, press Add to workflow…, pick one, then Add (their name); only published workflows that start By hand are offered',
      'Take them off a workflow: their page, the Workflows card, Remove',
      'Choose who looks after them: their page, the Assigned to card',
      'Link a pet, vehicle or property: their page, the Relationships card, Add',
      'Record whether they agreed to calls: their page, Details tab, Change beside Calls from us',
      'Archive them: their page, ⋯, then Archive',
      'Delete them for good: their page, ⋯, then Delete for good… (owners); everything only about them goes, their bills stay with just their name, and they wait 30 days in Settings → Deleted bin',
      'Merge a duplicate: their page, ⋯, Merge…, pick the other record, choose which one to keep, then Merge (owners and admins)',
      'Pause their funnel, or take them out of it: their page, the funnel line under their name, Pause or Remove from (the funnel)',
    ],
    canChange: [
      'their funnel: pause or resume it for them, move them to another stage, take them out, add them to one, or answer the AI teammate’s suggestion of one',
      'choose who looks after them: add, take off, make main (owners and admins)',
      'record that they agreed in writing to calls (and where), or don’t want calls; record that they don’t want texts',
      'text or email another of their numbers or emails on file',
      'add their pets, vehicles or properties, change them, and relate records',
      'put them on a maintenance plan',
    ],
    path: '/customers/people/[personId]',
  },
  {
    label: 'A company’s page',
    what: 'one company: its people, leads, notes, tasks and files',
    where: ['Contacts', 'Companies'],
    then: 'press the company',
    onScreen: [
      'At the top: its tags, and ⋯ with Edit details, Archive company and Delete for good… (owners)',
      'Along the top: Note, Log call, Task, Lead, File',
      'Tabs: Timeline, Leads, Tasks, Files, Details (Details has Edit and its Fields)',
      'Beside them: Assigned to, Open lead, Relationships (its People, with Add person)',
    ],
    howTo: [
      'Change its name, number, email or address: its page, ⋯, Edit details',
      'Put someone at the company: its page, the Relationships card, Add person beside People',
      'Fill in a field of your own: its page, Details tab, Edit beside Fields',
      'Archive it: its page, ⋯, then Archive company',
      'Delete it for good: its page, ⋯, then Delete for good… (owners); it waits 30 days in Settings → Deleted bin',
    ],
    canChange: [
      'change its details, other numbers, emails and addresses, and its own fields',
      'add a note, a logged call, a task or a lead on it',
      'archive it and bring it back (owners and admins)',
    ],
    notHere: ['calling, texting, booking or billing a company (do it with one of its people)'],
    path: '/customers/companies/[companyId]',
  },
  {
    label: 'A record’s page',
    what: 'one of the business’s own records (a pet, a vehicle, a property): its visits, tasks, files and who it belongs to',
    where: ['Contacts'],
    then: 'press the tab for its kind (Pets, Vehicles…), then the record',
    onScreen: [
      'At the top: ⋯ with Edit details, Archive and its kind (Archive pet…), and Delete for good… (owners)',
      'Along the top: Book, Note, Task, File',
      'Tabs: Timeline, Appointments, Tasks, Files, Details (Details has Edit and its Fields)',
      'Beside them: Assigned to (when it’s kept to its people), Relationships, Upcoming appointments, and the conversations of the customers it belongs to',
    ],
    howTo: [
      'Book it in: its page, press Book',
      'Add a note or a task: its page, Note or Task',
      'Link it to its owner: its page, the Relationships card, Add',
      'Archive it: its page, ⋯, then Archive and its kind (Archive pet…)',
      'Delete it for good: its page, ⋯, then Delete for good… (owners); it waits 30 days in Settings → Deleted bin',
    ],
    canChange: [
      'change its name, notes and fields, and relate it to customers and other records',
      'book it, and add a note or a task on it',
      'archive it and bring it back',
    ],
    path: '/customers/records/[recordId]',
  },
  {
    label: 'Pipeline',
    what: 'the leads, as a board or a list, in their stages',
    where: ['Pipeline'],
    onScreen: [
      'A pipeline picker when there is more than one, Board or List, and New lead',
      'The board: drag a lead between stages; dropping it on a lost stage asks Why was it lost?',
      'The list: a Stage picker on each row',
      'Pressing a lead opens it at the side; Open full page opens its own page',
    ],
    howTo: [
      'Add a lead: Pipeline, press New lead, pick the customer (they need to be in Contacts first), then Create lead',
      'Move a lead: drag it on the board, change Stage in the list, or press a stage on the lead',
      'Switch pipeline: the picker at the top of Pipeline',
    ],
    notHere: [
      'filtering the board (Search everything at the top of the side menu finds a lead by its title or customer)',
      'moving many leads at once',
      'moving a lead to another pipeline once it is made',
      'changing the stages here (that is Settings → Pipelines)',
    ],
    path: '/pipeline',
  },
  {
    label: 'A lead',
    what: 'one lead: its stage, next step, value and history',
    where: ['Pipeline'],
    then: 'press the lead (Open full page for everything)',
    onScreen: [
      'The stages to press, and the next action (Set, or Change)',
      'Value, Assigned to, Last contact, Expected close, Source, Tags',
      'Note, Log call, Won and Lost (Reopen once closed); ⋯ has Edit details, Archive lead and Delete for good… (owners)',
      'Its full page adds Book, File, Add to workflow…, Qualification, Money (New estimate), Upcoming appointments and Workflows',
    ],
    howTo: [
      'Mark a lead won: press Won on it',
      'Mark it lost: press Lost, pick why, then Mark as lost',
      'Set a follow-up: type it in the next action box and press Set, or Change to move it',
      'Change its value, owner or close date: ⋯, then Edit details',
      'Quote a lead: Open full page, then New estimate in its Money card',
      'Book it: Open full page, then Book',
      'Delete a lead for good: ⋯, then Delete for good… (owners); it waits 30 days in Settings → Deleted bin',
    ],
    canChange: [
      'archive it and bring it back (owners and admins)',
      'delete it through the Deleted bin (owners)',
    ],
    path: '/leads/[leadId]',
  },
  {
    label: 'Calendar',
    what: 'the appointments',
    where: ['Calendar'],
    onScreen: [
      'New appointment, and Manage calendars (which opens Settings → Calendars)',
      'New webinar (when HandsFreeOS video calls are on)',
      'Today and the arrows; Day, Week, Month, Team and Resources; the Person picker; a chip for each calendar to show or hide it',
      'Press an empty time to book there; drag an appointment to move it, or its bottom edge to change its length',
    ],
    howTo: [
      'Book an appointment: Calendar, press New appointment (or an empty time), fill in Customer, Calendar, Service, With, Date, Start, Length and Location, then Book; untick Tell (their name) to book without messaging them',
      'See one person’s week: Calendar, Week, then pick them in Person',
      'Book repeat visits: in New appointment, pick Every week, Every 2 weeks or Every month under Repeats and how many visits, then Book; Repeats shows when the calendar’s Repeats section has Staff can repeat visits on, and dates that don’t fit are listed, not booked',
      'Book someone who isn’t a customer yet: in New appointment, type their name under Customer; when nobody matches, press Add (their name) as a new contact, save them, and they’re the customer (the phone app’s New appointment does the same under Who it’s for)',
      'Schedule a webinar: Calendar, press New webinar, then pick the date and whether it repeats',
      'Share a webinar: Calendar, press its date, then under Video call press Copy beside Link anyone can use',
    ],
    notHere: [
      'blocking time from the calendar itself (time off is Settings → My calendar, Add time off)',
    ],
    canChange: ['list appointments over any dates, done, missed or cancelled included'],
    path: '/calendar',
  },
  {
    label: 'An appointment',
    what: 'one visit: the customer, where, who is going, the job and its money',
    where: ['Calendar'],
    then: 'press the appointment',
    onScreen: [
      'Customer: the name opens their page; Call, Text or Email; Mark confirmed (or Take back)',
      'The deposit and invoice for the visit, with Open the invoice',
      'Seats, for group sessions: Add, and once it starts Attended or No-show beside each person',
      'Waitlist: Remove beside each',
      'Video call, for a HandsFreeOS call: for a webinar, Copy beside Link anyone can use',
      'Zoom link: Make link, when the link didn’t make itself',
      'After the call and Transcript, for recorded calls',
      'Where: Directions',
      'People and equipment: Change',
      'Reminders (what went out, and when), and anything else on this visit',
      'Job: Scheduled, On the way, Started, Waiting on parts, Done (each texts the customer); Note the customer may see',
      'At the bottom: Reschedule, Complete, No-show, Invoice this visit, Cancel, and under them Delete for good… (owners)',
    ],
    howTo: [
      'Move it: open it and press Reschedule, or drag it on the calendar',
      'Give it to someone else: open it, press Change under People and equipment',
      'Cancel it: open it, press Cancel, choose whether to tell the customer and give a reason, then Cancel appointment',
      'Mark it done or a no-show: open it, press Complete or No-show (the other one is offered afterwards to undo it)',
      'Tell the customer you are on the way: open it, press On the way under Job',
      'Bill the visit: open it, press Invoice this visit',
      'Mark who came to a class: open it, press Attended or No-show beside each person under Seats',
      'Take someone off the waitlist: open the session, press Remove beside them under Waitlist',
      'Make a Zoom link that didn’t make itself: open it, press Make link under Zoom link',
      'Read what was said on a recorded call: open it, see Transcript (and After the call)',
      'Delete it for good: open it, press Delete for good… (owners); one still to come is cancelled first, telling the customer unless that’s unticked',
    ],
    notHere: ['changing the customer or service after booking'],
    canChange: [
      'mark it done or a no-show, or switch it',
      'mark the customer confirmed, or take a team mark back',
      'change its title, notes, where it is, or the deal it’s for',
      'move the job along (On the way, Started, Waiting on parts, Done) and the note the customer sees — each texts them',
      'add a customer to a group session, or take one off',
      'book repeat visits, and cancel one visit of a series, it and the ones after, or every upcoming one',
      'see who is waiting on a calendar’s waitlist, put a customer on it for a full session or a window of time, or take them off',
    ],
    path: '/calendar',
  },
  {
    label: 'Money',
    what: 'invoices, estimates, payments and maintenance plans',
    where: ['Money'],
    onScreen: [
      'Tabs: Invoices, Estimates, Payments, Plans',
      'New estimate and New invoice, at the top',
      'Outstanding, Overdue and Collected in 30 days; search, and a status filter',
    ],
    howTo: [
      'Write an estimate: Money, press New estimate, pick the customer, fill What it is for, then Add a line or Add from the catalogue, then Send (or Save draft)',
      'Write an invoice: Money, press New invoice, the same way; When it is due sets the terms',
      'Give a discount: in the estimate or invoice, Take off, then a % or an amount',
      'Ask for a deposit on an estimate: in the estimate, the Deposit card, Ask for a deposit',
      'See overdue invoices: Money → Invoices, then Overdue in the status filter',
    ],
    notHere: [
      'attachments, a preview, or sending later on an estimate or invoice',
      'deleting a draft (Void it)',
      'recurring invoices (maintenance plans bill themselves instead)',
    ],
    canChange: [
      'write an estimate or an invoice, with lines from the catalogue or typed, a discount, a deposit and a note',
      'change a draft estimate or invoice, a line at a time',
      'read the Invoices, Estimates, Payments and Plans lists with their filters: status, search, how it was paid and the account',
    ],
    path: '/money',
  },
  {
    label: 'An invoice',
    what: 'one sent invoice: what is owed, and the payments against it',
    where: ['Money', 'Invoices'],
    then: 'press the invoice',
    onScreen: [
      'Record a payment, Copy link (the customer’s pay page) and Void',
      'Payments, with Refund on each one',
    ],
    howTo: [
      'Record cash or a check: Money → Invoices, press the invoice, then Record a payment',
      'Refund a payment: Money → Invoices, press the invoice, then Refund on the payment (Money → Payments opens the same invoice)',
      'Send the pay link again: press the invoice, Copy link, and paste it in a text or email',
      'Get a PDF: press Copy link, open the link, then Print or save a PDF',
    ],
    notHere: [
      'a resend or reminder button (reminders go out on their own from Settings → Payments, Invoice reminders)',
      'a PDF download for the team (the customer’s page has Print or save a PDF)',
      'changing an invoice once it is sent (void it and write a new one)',
    ],
    canChange: [
      'send a draft invoice by email or text',
      'record cash, a check or another payment taken by hand',
      'give the customer’s pay link, for them to paste into a text or email',
      'void it',
      'refund a payment, all or part',
    ],
    path: '/money/invoices/[invoiceId]',
  },
  {
    label: 'An estimate',
    what: 'one sent estimate, and what the customer did with it',
    where: ['Money', 'Estimates'],
    then: 'press the estimate',
    onScreen: [
      'Turn into an invoice, They said yes, Copy link (the customer’s page to approve it) and Void',
      'What has happened, and Invoices from this',
    ],
    howTo: [
      'Record a yes given by phone: Money → Estimates, press the estimate, then They said yes',
      'Bill an approved estimate: Money → Estimates, press it, then Turn into an invoice',
    ],
    notHere: ['a resend or follow-up button (the nudge is Settings → Payments, Invoice reminders)'],
    canChange: [
      'record a yes given by phone',
      'turn it into an invoice, the whole job or just the deposit, and the account it is paid into',
      'give the customer’s link to approve it',
      'void it',
    ],
    path: '/money/estimates/[estimateId]',
  },
  {
    label: 'Plans',
    what: 'maintenance plans that bill themselves, and who is on one',
    where: ['Money', 'Plans'],
    onScreen: [
      'Put someone on a plan and New plan, beside the filters',
      'The plans: press a plan’s name to change it (Name, Price, Bills, What it includes, Charge sales tax on it) or Stop selling it; Set visits for each',
      'Who is on a plan; pressing someone opens their plan: Ask for a new card, Copy link, Pause (or Start it again), Cancel the plan (Cancel at the end of the period for a Square plan); while it waits on a card, Email them the link or Text it instead',
      'Their plan’s schedule: Bills on, Next charge, Paid into (with Change the account), Card on file, Charged by; then What it has billed',
    ],
    howTo: [
      'Put a customer on a plan: Money → Plans, press Put someone on a plan, pick the customer, the plan and the account, then Start the plan, and send them the link from their plan',
      'Pause or cancel someone’s plan: Money → Plans, press them, then Pause or Cancel the plan (Cancel at the end of the period for a Square plan)',
      'Move someone’s plan to another account: press them, then Change the account',
      'Send the card link again: press them, then Email them the link or Text it instead',
      'Change the card on a plan: press them, then Ask for a new card',
      'Make a new plan to sell: Money → Plans, press New plan, then Add plan (whoever manages money)',
      'Change a plan’s price or what it includes: Money → Plans, press its name, then Save; people already on it keep what they signed up for',
      'Stop selling a plan: press its name, then Stop selling it; anyone on it stays on it',
      'Put one customer on a plan from their page: their Money tab, Put on a plan',
    ],
    canChange: [
      'put a customer on a plan and send them the card link',
      'pause, restart or cancel someone’s plan, or ask them for a new card',
      'move someone’s plan to another account',
      'give the customer’s link to their plan',
      'add, change or stop selling a plan',
    ],
    path: '/money/plans',
  },
  {
    label: 'Workflows',
    what: 'automatic follow-ups, built as steps, on a canvas, or described in a sentence',
    where: ['Workflows'],
    onScreen: [
      'Tabs: Workflows, Runs, Approvals',
      'New workflow, at the top: a recipe, From Go Biz Help (templates your agency installed), Describe it, or Start blank',
      'Search workflows; All, Active, Paused, Drafts; an On or off switch on each',
      'Where each came from: Recipe, Go Biz Help (with its version) or Blank; Update available, with Review update beside it, when the agency’s template has a newer version',
      'Runs: All workflows or one; All, Going, Needs approval, Failed, Completed, Stopped; Real runs or Tests; Last 24 hours, Last 7 days, Last 30 days or Any time; Load more at the bottom',
      'Approvals: Waiting · N and Decided · N; All, Workflows and the AI teammate by name; Review on each, then Approve and send (or Approve) and Reject…',
    ],
    howTo: [
      'Start a workflow: Workflows, press New workflow, pick a recipe (or Describe it, or Start blank), name it, then Create draft',
      'Pause one: its On or off switch in the list, or Pause in the workflow',
      'Retry a failed step: Workflows → Runs, press the run, then Retry (or Skip)',
      'See test runs: Workflows → Runs, then Tests',
      'Approve what a workflow wrote: Workflows → Approvals, press Review, then Approve and send',
      'Take the agency’s update to a template: Review update beside Update available, then Apply the update; it lands in the draft, to test and publish',
    ],
    notHere: [
      'deleting, copying or bringing back an archived workflow',
      'putting many customers on a workflow at once (one at a time from their page)',
    ],
    canChange: [
      'start a workflow from a recipe or from scratch, or draft one from what you describe',
      'rename a workflow or change its description',
      'pause or resume a workflow, or archive one',
      'approve or reject what a workflow wrote',
      'start someone on a workflow that starts by hand, or take them out',
      'stop a run, or retry or skip the step it failed on',
      'apply the agency template’s update to a workflow',
    ],
    path: '/workflows',
  },
  {
    label: 'A workflow',
    what: 'the editor: what starts it, its steps, its settings, the test and publishing',
    where: ['Workflows'],
    then: 'press the workflow',
    onScreen: [
      'Steps, Canvas or Describe; Undo, Redo and Settings',
      'At the top: History, Pause or Resume, Publish, and ⋯ with Archive…',
      'Beside the steps: Step, Checks and Test',
      'The When card at the top is what starts it: an Event, a Schedule, a Date, a Webhook, or By hand',
      'The + between steps adds one, in groups: Message the customer (Send a text, Send an email, AI teammate calls them); The customer; The lead; Tasks and the team; The conversation; Other workflows and apps; Timing and paths (Wait, If / else, Split into paths, AI picks a path); AI and approvals (AI step, Approval); Finish a path (Go to another step, End)',
    ],
    howTo: [
      'Change what starts it: open it, Steps, press the When card at the top',
      'Start one when an estimate goes out, is approved or declined, an invoice is paid or overdue, a form is answered, or the AI teammate hands over: the When card, Event, then Money, Forms, or Messages and calls',
      'Add a step: press the + between two steps',
      'Move, duplicate or delete a step: press the step, then its ⋯, then Move to…, Duplicate or Delete',
      'Stop it when the customer replies: Settings, then Stop the run when they, Reply by text or email',
      'Let someone go through it only once: Settings, Only once, ever',
      'Test it: Test, then Run test',
      'Publish it: fix what Checks marks red, run a test, then Publish',
      'Go back to an older version: History, Restore, then test and publish again',
      'Rename it: press its name at the top',
    ],
    canChange: [
      'change its steps, what starts it and its settings',
      'test it (Simulate or Send to me)',
      'publish it once a test passed',
      'bring back an older version into the draft',
      'apply a proposal I drafted',
      'pause or resume it',
      'rename it or archive it',
    ],
    path: '/workflows/[workflowId]',
  },
  {
    label: 'Campaigns',
    what: 'one-off outreach by text, email or calls, written by the AI and approved by a person',
    where: ['Campaigns'],
    onScreen: [
      'New campaign: Send as (Texts, Email or Calls), Name, About a promotion?, What’s it for?, Who gets it (tags and pipeline stages), and how many an hour, and for calls Keep adding people; then Write the texts, Write the email or Plan the calls',
      'Each campaign’s badge: Writing texts (Writing the email, Planning the calls), Ready to review, Sending (Calling), Paused, Done or Stopped; and Keeps adding on a call campaign that does',
      'A campaign in review: each message can be edited or removed, then Approve all and send (Approve all and start calling, for calls)',
      'An email campaign: the email, Edited once it’s changed, and the footer every email gets (why they get it, an unsubscribe link, the business address)',
      'A call campaign: How every call opens, Keep adding people, and each person’s call (Talked, Voicemail, No answer, trying again, Calling now) with what was said',
      'Once it is going: Pause, Resume, Stop, and Change beside the pace',
      'N people left out: each name, and why',
    ],
    howTo: [
      'Send a text campaign: Campaigns, press New campaign, choose Texts, pick who gets it, press Write the texts, check them, then Approve all and send',
      'Leave someone out: in review, Remove on their row',
    ],
    notHere: [
      'starting at a set time later',
      'copying or deleting a campaign',
      'results beyond who it went to (no replies, bookings or revenue)',
    ],
    canChange: [
      'start one by text, email or calls, with who it reaches and who is left out',
      'change one person’s text, the email or the call opening, or take someone out',
      'approve all and send',
      'pause, resume, change the pace, or stop it',
      'keep adding people to a call campaign, or stop adding them',
    ],
    path: '/campaigns',
  },
  {
    label: 'Forms',
    what: 'forms, surveys, quizzes and live polls customers fill in, and the website chats',
    where: ['Forms'],
    onScreen: [
      'New form: its name, Form, Survey, Quiz or Live poll, or a starter; then Create',
      'A form: Questions, Design, Preview, Results and Share, with Undo and Publish (Publish changes once it’s out); a live poll has Questions, Preview and Results',
      'Design: Match my website, Colours, Font, Shape, Button, Layout, and Use on all my forms',
      'Results: the totals, and One at a time: each person’s answers',
      'Share: Copy the link, a QR code to Download, Sites allowed to show it, Copy the snippet for your website, and Let the AI teammate ask it',
      'Website chats: each chat, and New website chat',
    ],
    howTo: [
      'Make a form: Forms, press New form, name it, pick a kind or starter, Create, add questions, then Publish',
      'Save an answer onto the customer: press the question, then Where the answer goes',
      'Send a form to a customer: its Share tab, Copy the link, and text it; or turn on Let the AI teammate ask it',
      'Put it on your website: Share, list the site under Sites allowed to show it, then Copy the snippet',
      'Download the answers: Results, Export to CSV',
      'Delete one person’s answers (for good): Results, One at a time, open theirs, then Delete this response',
    ],
    notHere: [
      'changing the thank-you message, or being emailed when someone answers',
      'deleting a form for good (archive it)',
    ],
    canChange: [
      'build a form or change its questions (and when one shows), its pages, how it looks and how it behaves, as a draft',
      'match its look to a website',
      'publish it, close it or take answers again',
      'text or email someone its link',
      'fill it in for a customer with the answers they gave',
      'which sites may show it, and Let the AI teammate ask it',
      'use its design on all my forms',
      'rename, copy, archive or bring back a form',
      'change its link',
    ],
    path: '/forms',
  },
  {
    label: 'Documents',
    what: 'contracts and agreements customers sign online, and the templates they’re sent from',
    where: ['Documents'],
    onScreen: [
      'At the top: New template (owners and admins) and Send a document',
      'Sent: every document sent, by state, and Show older ones; Templates: In use and Archived, each Ready to send or Not ready yet',
      'Pressing a document opens it: Remind and Void while it’s out, Open the signed copy and Download once everyone signed, and Send it again',
      'Beside it, Who signs: each signer and where they are, Sign now when it’s their turn, and Copy their link; then What happened',
    ],
    howTo: [
      'Send a document to sign: Documents, press Send a document, pick the template and who signs, then send it',
      'Send the signing link again: press the document, then Remind',
      'Give a signer their link yourself: press the document, then Copy their link beside them',
      'Have someone sign on your device: press the document, then Sign now beside them when it’s their turn',
      'Take a document back: press the document, then Void',
      'Fix a document already sent: press it, Void, then Send it again, which starts a new one from it',
      'Make a template: Documents → Templates, New template, name it and choose its PDF, then place the fields for each signer (Place fields for me does it for you)',
      'Change a template: Documents → Templates, then press the template',
    ],
    canChange: [
      'send a document from a template',
      'remind the signers, or void a document',
      'give the person a signer’s own link to pass on',
      'make, rename, copy, archive or restore a template, and change who signs it, its fields, its words and When it’s sent',
      'place a template’s fields with the AI, as Place fields for me does',
      'read what a template’s or a document’s PDF says, and open the signed copy',
    ],
    notHere: [
      'changing a document once it’s sent (void it, then Send it again)',
      'sending one document to many customers at once (send it to each)',
      'deleting a template (archive it; it can be restored)',
    ],
    path: '/documents',
  },
  {
    label: 'A document',
    what: 'one document sent to sign: who it’s about, who signs and where each has got to, and what happened',
    where: ['Documents'],
    then: 'press the document',
    onScreen: [
      'Its name and state (Out for signing, Making the signed copy, Signed, Declined, Voided or Out of time), About and who it’s about, Sent and when by whom, and Out of time on its day',
      'While it’s out: Remind and Void (Why (they see this), then Void it or Keep it out)',
      'A note when it was voided, declined or ran out of time, with the reason; once everyone signed, the signed copy is on their Files, locked, with a proof page at the end',
      'Once everyone signed: Open the signed copy and Download (on the phone, Share the signed copy); once it’s voided, declined or out of time: Send it again',
      'Who signs: each signer in order with their role, email and phone, where they are (Not their turn yet, Link on its way, Signs with you in person, Sent, Opened, Signed, Declined) and when, Sign now when it’s their turn, and Copy their link (on the phone, Send their link); then who Gets a copy',
      'What happened: every step with its time and where from (link sent, reminded, opened, code checked, agreed, signed, declined, voided, signed copy filed and sent)',
    ],
    howTo: [
      'Remind them: press the document, then Remind; the link goes again by email and text to whoever’s turn it is',
      'Void it: press the document, Void, say why (they see it), then Void it',
      'Send a corrected one: void it, then Send it again',
      'Get the signed copy: press the document, then Open the signed copy or Download; it’s on their Files too',
    ],
    canChange: [
      'remind the signers, void it, or send it again',
      'give the person a signer’s own link, to pass to that signer only',
      'open the signed copy, or the PDF it was sent from',
    ],
    notHere: ['changing it once it’s sent (void it, then Send it again)'],
    path: '/documents/[documentId]',
  },
  {
    label: 'A document template',
    what: 'one template: its PDF, who signs it, the fields each fills in, the words typed over, and When it’s sent',
    where: ['Documents', 'Templates'],
    then: 'press the template',
    onScreen: [
      'Its name with Rename, Ready to send or Not ready yet, how many are out for signing, Saving or Saved, and Send it',
      'Place fields for me (the AI places them), Undo, and More: Swap the PDF, Make a copy, Archive or Restore',
      'The PDF’s pages, with each field and each change to the words on them',
      'Who signs, in order: each one, What they’re called, A customer or Someone on your team, Signs earlier or Signs later, and Take them off; + Customer and + Someone on your team; and You, before sending, for what the business fills in',
      'Add for each signer: Signature, Initials, Date signed, Name, Email, Phone, Text, Paragraph, Number, Date, Checkbox and Pick one; The PDF’s words: Change words and Add words',
      'A field picked: Who fills it in, Kind, What it asks for, Has to be filled in, Fill in from HandsFreeOS, Choices, Text size and Take it off; words picked: Now says, Font, Size, Bold, the colours and Put the original words back',
      'When it’s sent: Who signs when (One after another or All at once), Ask for a code, Send reminders (First after, Then every), Out of time after, and the Note with the link',
      'Before it can go out: what stops it, or Nothing. It’s ready to send.',
    ],
    howTo: [
      'Let the AI place the fields: the template, then Place fields for me; check each one and who it’s for',
      'Change a field: the template, press the field, then change it beside the page; it saves itself',
      'Change the PDF’s words: the template, Change words under The PDF’s words, then press the words',
      'Add someone who signs: the template, + Customer or + Someone on your team under Who signs',
      'Turn reminders off or change them: the template, Send reminders under When it’s sent',
      'Use a new PDF: the template, More, then Swap the PDF',
    ],
    canChange: [
      'change who signs, any field, the PDF’s words and When it’s sent, one thing at a time',
      'let the AI place the fields, as Place fields for me does',
      'rename, copy, archive or restore it',
    ],
    notHere: ['deleting a template (archive it; it can be restored)'],
    path: '/documents/templates/[templateId]',
  },
  {
    label: 'A knowledge item',
    what: 'one FAQ, article, fact or document in the knowledge base: its words, tags and status, where it came from and how often the AI used it',
    where: ['Knowledge', 'Items'],
    then: 'press the item',
    onScreen: [
      'All items, back to the list',
      'Its kind (FAQ, Article or Fact; a document stays a document), when it was updated and by whom, and its status',
      'For a document: a note when no text could be read from its file, or only the first 100,000 characters were kept',
      'The question and answer, or the title and text, then Tags',
      'Where it came from (added by hand, from the website with its page, from a question the AI couldn’t answer, or from a Go Biz Help pack), who added it and when, and how often the AI used it',
      'Publish (Publish again once archived), Save or Save draft, and Archive',
    ],
    howTo: [
      'Change what it says: the item, change the words, then Save',
      'Let the AI use a draft: the item, then Publish',
      'Stop the AI using it: the item, then Archive; Publish again brings it back',
    ],
    canChange: [
      'read it whole, with where it came from and how often it was used',
      'change its words, kind or tags, publish it, archive it or bring it back',
    ],
    notHere: ['deleting an item (archive it instead)'],
    path: '/knowledge/items/[itemId]',
  },
  {
    label: 'Build your main offer',
    what: 'the builder for the business’s main offer, a step at a time, with the AI’s help, its score and its tries',
    where: ['Settings', 'Main offer'],
    then: 'press Change your offer, Open the draft or Start building',
    onScreen: [
      'Building your main offer, the step it’s on (N of 10), Draft saved, and Finish later',
      'Your niche: your best customer, then Find my niche (or I don’t have customers yet, then Suggest niches for me), and Use this niche and continue',
      'Who, Outcome, Timeframe, Method, Guarantee and Price: each box with Improve or Write it for me (Pick one, or keep yours), and examples to model',
      'Proof: your real results, Add a result, and Improve to tidy them (the AI never makes one up)',
      'Put it together: your offer in one line, and For your messages (the outcome and the guarantee in a few words), with How a first message will read',
      'Review and go live: Score my offer, How each part scored, The quick checks, Go live, Use it anyway…, your direction, and the tries (Make Try N, then pick what to keep and Apply to my draft)',
    ],
    howTo: [
      'Have the AI find who to sell to: Your niche, then Find my niche',
      'Better words for a box: press Improve (or Write it for me when it’s empty), then Use this on the one you like',
      'Score it: Review and go live, then Score my offer',
      'Put it live: Review and go live, then Go live (or Use it anyway… with a reason when a part is under 7)',
      'Have the AI write a try: Review and go live, a note on any part, then Make Try N',
    ],
    canChange: [
      'change any box, the steps or the results, score it and put it live with your OK',
      'ask for niches, or Improve and Write it for me on a box, with nothing saved until you pick',
      'have the AI write a try, and take parts of it into the draft',
    ],
    path: '/main-offer/build',
    queryIds: { try: 'main offer try' },
  },
  {
    label: 'Send a document',
    what: 'sending a template to sign',
    where: ['Documents'],
    then: 'press Send a document (or Send on a template, Document on a customer’s page, or Send it again on a document)',
    onScreen: [
      'Template: Pick one; Who it’s for: a customer (or the company, lead or record it was opened from), with Change',
      'What stops it going out, when anything does; What it’s called',
      'Who signs: each role in order with who it suggests (the customer, or you for your team’s), a customer or someone on your team to pick, and With you now for someone signing in person; Gets a signed copy',
      'Filled in before it goes: your part and what HandsFreeOS filled in for them; Change the words for them only (the template stays as it is)',
      'The note and the settings: Note with the link, Who signs when, Ask for a code, Send reminders, Out of time after; then Send it',
    ],
    howTo: [
      'Send one to a customer: their page, press Document, pick the template, then Send it',
      'Change the words for one customer only: on Send a document, Change the words for them, then press the words',
      'Someone signs with you in person: on Send a document, With you now beside them, then Sign now on the document when it’s their turn',
    ],
    canChange: [
      'send it, with who signs, who gets a copy, what’s filled in, their own word changes, the note and the settings',
    ],
    notHere: ['sending one document to many customers at once (send it to each)'],
    path: '/documents/send',
    queryIds: { template: 'document template', from: 'earlier document it sends again' },
  },
  {
    label: 'Reviews',
    what: 'Google and Facebook reviews, and answering them',
    where: ['Reviews'],
    onScreen: [
      'Google and Facebook: Connect; once connected, Read again (the refresh button) and Disconnect (the unplug button), and a red line when reviews stopped coming in',
      'Sign in again is a red badge, not a button: press Disconnect, then Connect',
      'Average stars, and a filter for the unanswered ones',
      'Each review: Answer (a Facebook review has Answer on Facebook instead)',
    ],
    howTo: [
      'Answer a review: Reviews, press Answer on it, write, then Answer',
      'Sign Google in again: Reviews, press Disconnect on Google’s card, then Connect',
      'Ask customers for reviews: Workflows, New workflow, the recipe Appointment follow-up + review; the link it sends is Review link on Settings → Workspace',
    ],
    notHere: [
      'asking for reviews from this page (a workflow does it)',
      'editing or deleting an answer once it’s posted',
      'answering a Facebook review here (that’s done on Facebook)',
    ],
    canChange: [
      'answer a Google review (it’s public)',
      'read Google or Facebook again now',
      'stop reading one (disconnect); the reviews already here stay',
    ],
    path: '/reviews',
  },
  {
    label: 'Tasks',
    what: 'to-dos for the team',
    where: ['Tasks'],
    onScreen: [
      'Mine or Everyone, and New task (Task, Due, At a specific time, Assigned to, Notes)',
      'Overdue, Today, This week, Later, No due date, then Recently done; the circle ticks a task off, and ⋯ has Edit, Open lead and Delete',
    ],
    howTo: [
      'Add a task: Tasks, press New task, then Add task',
      'Add a task about a customer: their page, press Task, then New task; about a lead: New task in the lead’s Tasks section (New task on the Tasks page can’t attach one)',
      'Tick a task off: press its circle (Recently done has the ones to undo)',
      'Change or delete a task: its ⋯, then Edit or Delete',
    ],
    notHere: [
      'repeating tasks, priorities or subtasks',
      'searching the Tasks page itself (Search everything at the top of the side menu finds a task by its title or notes)',
    ],
    path: '/tasks',
  },
  {
    label: 'Search',
    what: 'every result for what was typed in Search everything, by kind',
    where: [],
    then: 'type in Search everything at the top of the side menu, then press Enter with no row picked',
    onScreen: [
      'Kinds of results down the side, each with its count, All first; Include archived and Only mine',
      'Each kind’s best results, with Show N more under them, and Only <kind> to open that kind on its own',
      'One kind on its own: Include archived and Only mine; for contacts, All · Leads · Clients and Sort (Best match, Most recent contact, Name A–Z), and Compare and merge where two share a number or an email; Show 50 more',
      'A kind searched only so far back (messages, notes, the words inside files, form answers) says how far, with Look further back; Messages has Look in Spam',
    ],
    howTo: [
      'See every result: type in Search everything, then press Enter',
      'Look in one kind only: on the Search page, press the kind (or Only <kind> under it)',
      'Merge two contacts who share a number: open Contacts on its own on the Search page, then Compare and merge',
    ],
    path: '/search',
  },
  {
    label: 'Audit log',
    what: 'who changed what, and when',
    where: ['Audit log'],
    onScreen: [
      'Today, 7 days or 30 days; Filter by person (Everyone, a person, a workflow, All workflows, the AI teammate or HandsFreeOS (system)); a search',
      'Filter by activity: All activity, Members, Invitations, Workspace, Contacts, Inbox & texting, Calendar, Leads, Tasks, Files, Imports, Workflows, Action Center or Assistant',
      'Show what HandsFreeOS noticed (with All activity or Action Center): what the Action Center noticed on its own, hidden until it’s ticked',
      'Each entry: the time, who did it and what in a sentence, its kind and where it came from; press it to see what it was before and after, and why',
    ],
    howTo: [
      'See what someone changed: Audit log, pick them in Filter by person, then press an entry',
      'See what the AI teammate did: Audit log, Filter by person, then the AI teammate',
      'See what was changed through Ask HandsFreeOS: Audit log, Filter by activity, then Assistant',
    ],
    notHere: ['anything older than 30 days', 'exporting the log'],
    path: '/audit',
  },
  {
    label: 'Ideas',
    what: 'ideas for HandsFreeOS itself, the roadmap and what’s new',
    where: ['Ideas'],
    onScreen: [
      'Tabs: Ideas, Roadmap, What’s new',
      'Share an idea, at the top; search, sort and filters (Status, Area, Whose); a vote on each; Show more ideas',
      'An idea: Where it stands and what that means, vote, What happened (each move with the team’s note), comment, Delete on your own comments, Edit your idea (until the team answers it), and Email me updates',
      'Roadmap: Planned, In progress and Done lately (the last 90 days)',
      'What’s new: each update, newest first, with the ideas it answers',
    ],
    howTo: [
      'Suggest something: Ideas, press Share an idea',
      'Follow an idea: open it, turn on Email me updates',
      'Fix the words of your own idea: open it, press Edit your idea (only until the team answers it)',
    ],
    canChange: [
      'find ideas and read one with its comments, its story and the team’s notes, the roadmap and What’s new',
      'share an idea, vote or take a vote back, comment, and follow one or stop',
      'edit your own idea until the team answers it, and delete your own comment',
      'give a link to an idea that opens it for anyone on HandsFreeOS',
    ],
    notHere: ['deleting an idea once shared'],
    path: '/ideas',
  },
  {
    label: 'Agency area',
    what: 'for the agency that runs several businesses: client businesses, workflow templates, knowledge packs, saved setups and migrations',
    where: [],
    then: 'press the business name at the top of the side menu, then Agency area (agency owners and admins only)',
    onScreen: [
      'Client businesses, Templates, Knowledge packs, Saved setups, Migrations',
      'Client businesses: Add a client business, then each business with its Setup (All, Stuck, Setting up, Done); press Setup for its steps, with Email <name> a reminder, Open the setup, Open their workspace, and Do it for them on a step',
      'Templates: New template, Save a workflow as a template, and Publish and Push… on each, with Installed in and Who’s behind',
      'A template’s own page: Checks, Test (Simulate only), Publish, Push…, Installed in and Versions',
      'Knowledge packs: New pack, then Edit and Push on each, and Archived (n); Archive or Restore is in Edit',
      'Saved setups: Save from a business, then Rename and Remove on each',
      'Ask HandsFreeOS isn’t in the Agency area: ask from any of the agency’s businesses',
    ],
    howTo: [
      'Send a workflow to client businesses: Agency area, Templates, Push… on the template, pick the businesses, match the details, then Push',
      'Send starter FAQs to client businesses: Agency area, Knowledge packs, New pack, Save pack, then Push',
      'Nudge a client who’s stuck on setup: Agency area, Client businesses, press Setup on theirs, then Email <name> a reminder',
      'Start new businesses from one’s answers: Agency area, Saved setups, Save from a business, pick the business, name it, then Save',
    ],
    canChange: [
      'see the client businesses with how far each has got setting up, the templates with who’s behind, the knowledge packs with what each business accepted, the saved setups and the migrations',
      'add a client business, and email a client’s owners a reminder to finish setting up',
      'make, rename, change the steps of and publish a template, or save a workflow as one',
      'push a published template, with its details matched for each business, or a knowledge pack, to client businesses',
      'make, change, archive and restore a knowledge pack, copying from a business’s published knowledge',
      'save a business’s setup answers, rename a saved setup, and remove one',
      'start, set up, pause, carry on and retry a migration for the whole agency',
    ],
    path: '/app/org/[orgId]/templates',
  },
];

/** What is on every page, around the page itself. */
export const EVERY_PAGE: readonly string[] = [
  'Top of the side menu, on every business page: the bell beside the HandsFreeOS name, the business name (press it to switch businesses, Create workspace to add one, or the Agency area), Search everything (⌘K or Ctrl K), and Ask HandsFreeOS (⌘J or Ctrl J), which is you',
  'The bell (in the bar along the top on a narrow screen) opens Notifications: Needs you first, the add-ons’ alerts still open, then Recent, what HandsFreeOS sent to their phone for this business in the last 30 days, newest first, with the ones not opened yet marked; pressing one opens what it’s about, and Show older shows more. Its count is what came since they last opened it, and the alerts still open. What they’re sent at all is Settings → Account (Notifications)',
  'Ask HandsFreeOS, the panel: Your chats lists their chats here, newest first (⋯ on one has Rename and Archive; only they can see them, and renaming or archiving one is theirs to do), New chat starts a fresh one, and Close hides the panel. Under the box: Talk out loud to talk instead of type and hear the answer, Stop to end an answer, Send; Copy under an answer copies it, and a card waiting for an OK has its own buttons',
  'Search everything finds, for whoever may see them, customers, companies, leads, estimates, invoices and payments, messages and calls, appointments, tasks, notes, files and the words inside them, forms and their answers, Knowledge, the business’s own kinds of records, Real Estate’s listings, deals, homes and properties, and settings; archived things show under Archived, and the Deleted bin to whoever may delete for good. Enter with no row picked opens the Search page with every result. A place hidden from the side menu isn’t found by it, but still opens from a link',
  'Settings has its own Search settings box at the top of its menu',
  'Bottom of the side menu: Add-ons (owners and admins) and Ideas, the places about HandsFreeOS itself, then Turn on calls in this browser (then Calls ring in this browser), Get help (In a few words, What happened?, then Send it; a person at HandsFreeOS answers; while Getting started isn’t finished it’s a menu first: Getting started, Take the tour, and Ask us for help, which opens that message), and Sign out. Pressing their own name there opens their account menu: Sell HandsFreeOS (applying to sell HandsFreeOS for a share, their link and codes, getting paid, and agreeing to the affiliate terms) and Sign out',
  'Each person can reorder, group or hide places in their side menu (Settings → Account, under Side menu, then Edit menu: Move up, Move down, Move to a group, Add a group, Group name, Ungroup, Hide and Show, Use suggested groups, Start over, then Save menu); a place may be inside a group called More; Home and Settings never hide; an add-on that’s on is a place there too; Add-ons and Ideas sit apart at the bottom and are never moved or hidden',
  'A place their role doesn’t allow isn’t in their side menu at all: Inbox, Money, Documents (whoever sends them) and Audit log need their own permission',
  'You can send the Get help message for them, and add a business the way Create workspace does (organization owners and admins)',
];

/** What people ask for that HandsFreeOS doesn’t do anywhere, so the Assistant says so plainly. */
export const NOT_ANYWHERE: readonly string[] = [
  'deleting an add-on’s records for good, such as Real Estate’s deals (they are archived; owners delete customers, companies, leads, records, conversations and bookings for good, and those wait 30 days in Settings → Deleted bin)',
  'choosing many rows of a list at once to change them together, other than deleting customers or conversations (the Assistant can tag many customers at once)',
  'exporting customers, leads or the audit log to a spreadsheet (form answers do have Export to CSV)',
  'a keypad to ring any number (calls start from a customer, a conversation or an item on Home)',
];

/** The phone app, which does less than the web. */
export const PHONE_APP: readonly string[] = [
  'The bar along the bottom: Home, Inbox, Pipeline, Calendar and More',
  'The bar along the top: the business’s mark on the left (press it, or Switch on their card at the top of More, to switch businesses: the Businesses sheet lists each one with its role, Open, and Keep on this phone; a business not kept on this phone opens only with signal, and Businesses on this phone, in its Settings, lists the same switches), then the bell (Notifications: Needs you, then Recent), the HandsFreeOS mark, which opens Ask HandsFreeOS, and the magnifying glass for Search everything. While someone views as a teammate the bell and Ask HandsFreeOS aren’t there',
  'More, top to bottom: Switch (businesses), each add-on’s own places, Changes on this phone, Contacts, Tasks, Money, Forms, Documents (for whoever can send them), Approvals, Set up your AI teammate (while there’s none) or Test your AI teammate and Run quick setup again (for whoever manages the AI teammate), View as a teammate (owners and admins: see the app as someone below them, read-only, until Stop viewing), Settings, Add-ons (for whoever manages them), Ideas, Get help, and Open on the web',
  'Changes on this phone, under More (and the strip under the top bar when something waits): what was changed on the phone and hasn’t reached HandsFreeOS yet. Needs you · N, each with what to do (Fix, or Discard, which sends nothing); Waiting · N, which go on their own once there’s signal; and Sent just now. Only the phone knows these: asked on the phone, the context lists them; asked on the web, you can’t see them, so ask what it says there. Fixing, sending or discarding one is done there, by them',
  'Pipeline: one stage at a time, with the stages as chips along the top showing their counts; tap a lead to open it, then Move to… to change its stage (it works with no signal, and Lost asks why); there is no dragging on the phone',
  'Tasks, under More: Mine or Everyone; the circle ticks one off (and reopens a done one); tapping a task opens its customer or lead; New task at the bottom',
  'Approvals, under More: Waiting and Decided, with the AI teammate’s drafts and workflow approvals together',
  'A customer, from Contacts: under their name, the funnel they’re in, its stage and what it sends next, with Pause or Resume and Remove from (the funnel); or the AI teammate’s suggestion of a funnel for them, with Yes, put them in or No (while there’s signal)',
  'Its Settings (More, then Settings), top to bottom: Search settings; This phone: My cell phone (where Call rings them first), Unlock with Face ID or a fingerprint, Businesses on this phone, Documents on mobile data (when an add-on keeps documents on the phone), Changes on this phone; This business: Usage & balance (for whoever manages money), Main offer (while an add-on uses it: its review, with Score my offer, Make a try, Go live, Use it anyway and Edit it myself on a part; building it, the method’s steps and comparing a try are on the web) and Partners (for whoever manages them); You: My safety (who is told if they don’t check out), Notifications, Profile and sign-in (it opens Settings → Account on the web, where the name, password, Google sign-in and passkeys are), and Appearance (System, Light or Dark, kept on that phone alone: the web’s Settings → Account has its own, and changing either never changes the other); then Sign out and Delete my account',
  'Notifications, in its Settings (More, then Settings): This phone first (Notifications on this phone: On, Off when the phone’s own settings turned them off, Not turned on, Waiting for signal, Not added, or Not in this build; with Turn on notifications, Open the phone’s settings or Try again), then Push and email (each kind with its push and email switches, and On N phones, how many phones their alerts go to) and Email only. The switches are the same ones as the web’s Settings → Account (Notifications), saved to their account; only This phone is the phone’s own',
  'Only on the web: workflows, the AI teammate’s settings, its instructions and its funnels (the phone has only its quick setup, its test, and a customer’s funnel line), Knowledge, members, the rest of the business’s settings and the agency area (More, then Open on the web)',
  'Set up your business runs on the phone too, from Home’s Getting started (Start, or Carry on where it was left on the computer); a Getting started step easier on a computer has Email me a link, which emails the person a link to it',
  `Getting the phone app: ${PHONE_APP_LINKS.links.map((l) => `${l.label}, from the ${l.from}: ${l.url}`).join('; ')}. These two links may be given as they are`,
  'Money, under More: invoices and estimates (and payments and plans for whoever manages money); on an invoice, Record cash or a check, Send and Send a payment link; on an estimate, Send and Send their link; New invoice on the web and New estimate on the web write one on the web',
  'Search everything: the magnifying glass at the top of the business’s screens, and Search everything under the Contacts and Inbox boxes; with no signal it searches what is on the phone (contacts, companies, leads, tasks, notes, the calendar, form names and settings) and says so',
  'Its Settings has a search box at the top; a setting only the web changes opens on the web',
];

/** What customers see, and where the business manages it, for "can my customer…" questions. */
export const CUSTOMER_PAGES: readonly string[] = [
  'The booking page: set up on Settings → Calendars → Booking site; each calendar’s own link is on Settings → Calendars',
  'The link in a booking confirmation lets the customer Confirm, Reschedule, Cancel or Book again, as each calendar’s Cancel & reschedule rules allow',
  'An estimate’s page: the customer approves it by typing their name, and can print it or save a PDF',
  'An invoice’s page: the customer pays by card or bank transfer, and can print it or save a PDF',
  'A plan’s page: the customer adds the card the plan bills',
  'A form’s link, from the form’s Share tab',
  'Your page, the one-page site: Settings → Workspace, under Your page is at',
  'A partner’s link, which makes whoever books through it their client: Settings → Partners, press the partner, Copy their link; their page in the portal shows it too',
  'Website chat: the chat box on the business’s own site, from the snippet under Add it to your site on the chat’s page (Forms, then Website chats)',
  'A webinar’s Link anyone can use, where people sign up and join: Calendar, press the webinar, then under Video call press Copy beside Link anyone can use',
  'The link asking a customer to send a video: Ask for a video in a conversation’s reply box; it’s shown only once',
  'The privacy policy and terms HandsFreeOS keeps for the business, written from its texting registration (Settings → Texting & calls); its simple page and its chat’s agreement box link to them',
  'A document to sign: each signer’s own private link, sent by email or text (or Copy their link beside them on the document); when the template asks, a 6-digit code first; they tick I agree to sign electronically, fill in their fields, draw or type their signature, then Finish and sign, or Decline to sign with a reason; it works on a phone; once everyone signed, each gets the signed copy (Download the signed copy)',
  'Their portal lists their own documents too: Sign it opens one whose turn it is without a code, and voided ones aren’t shown',
  'The customer portal: a client’s own page with their messages, files and documents to sign, and a partner’s own page (Settings → Partners, press the partner, Send their page); they sign in with a code sent to their email',
  'All of them except the portal and a document to sign can be on the business’s own web address (Settings → Workspace)',
];

/**
 * The same word in more than one place. These are the ones people get sent to the wrong screen for, so the prompt
 * says each of them outright.
 */
export const LOOK_ALIKES: readonly string[] = [
  'Service area: the territories that route bookings and that the AI teammate checks are Settings → Calendars → Territories; each calendar only uses them once Route by ZIP code is on in its own Territories section; the words the AI says about the area are Knowledge → Overview, in Business profile under Where and when (Service area).',
  'Hours: the business’s open hours are Settings → Workspace (Business hours); a person’s own are Settings → My calendar (Weekly hours); a calendar’s are its Availability section; the AI teammate’s are its Hours section.',
  'Notifications: what a person was sent is the bell at the top of the side menu (on the phone, in the bar along the top); what a person is told about is Settings → Account (Notifications); what customers get about a booking is the calendar’s Notifications section; reminders and follow-ups HandsFreeOS sends by itself are Settings → Automations.',
  'Quiet hours: only for what goes to customers, Settings → Texting & calls, in Texting rules. A person’s own alerts have no quiet hours: they turn a kind off in Settings → Account (Notifications), or on the phone under More, then Settings, then Notifications, or use the phone’s own Focus or Do Not Disturb; on an iPhone, Urgent items and safety check-ins can still break through Focus.',
  'Deposits: the default for estimates is Settings → Payments (Deposits); a deposit taken at booking is the calendar’s Payments section; one estimate’s own is its Deposit card.',
  'Payments: getting paid by customers is Settings → Payments; paying HandsFreeOS for texts and calls is Settings → Usage & balance; the money itself is Money; one payment’s refund is on its invoice.',
  'Approvals: what the AI teammate and workflows wrote waits in Workflows → Approvals (the AI teammate’s alone are also AI teammate → Approvals).',
  'Templates: saved texts and emails are Settings → Templates; contracts and agreements to send for signing are Documents → Templates; workflow templates for many businesses are the Agency area.',
  'Documents: contracts and agreements customers sign are Documents in the side menu; files the AI teammate reads are Knowledge → Documents; files on a customer are their page’s Files tab; estimates and invoices are Money.',
  'Team, teammates, staff: the side menu calls it Members.',
  'Connecting Google or Outlook: a calendar is Settings → My calendar; a mailbox is Settings → Email; signing in with Google is Settings → Account; Google reviews are Reviews.',
];

const trail = (where: readonly string[]) => where.join(' → ');

/** How a place is reached, in words: "Money → Invoices, then press the invoice". */
export const placeWay = (p: AppPlace): string =>
  p.where.length ? (p.then ? `${trail(p.where)}, then ${p.then}` : trail(p.where)) : (p.then ?? '');

/** One place as the prompt says it: "- Money is at Money: …. On it: …. How to: …". */
export function placeLine(p: AppPlace): string {
  const how = p.howTo.length ? ` How to: ${p.howTo.join('; ')}.` : '';
  const can = p.canChange?.length ? ` You can: ${p.canChange.join('; ')}.` : '';
  const not = p.notHere?.length ? ` Not in HandsFreeOS: ${p.notHere.join('; ')}.` : '';
  return `- ${p.label} is at ${placeWay(p)}: ${p.what}. On it: ${p.onScreen.join('; ')}.${how}${can}${not}`;
}

/** The places, the page around them, the phone and what customers see, for the fixed part of the prompt. */
export function placesText(): string {
  return [
    ...APP_PLACES.map(placeLine),
    'On every page:',
    ...EVERY_PAGE.map((l) => `- ${l}.`),
    `Not anywhere in HandsFreeOS: ${NOT_ANYWHERE.join('; ')}.`,
    'The phone app:',
    ...PHONE_APP.map((l) => `- ${l}.`),
    'What customers see:',
    ...CUSTOMER_PAGES.map((l) => `- ${l}.`),
    'The same word in more than one place:',
    ...LOOK_ALIKES.map((l) => `- ${l}`),
  ].join('\n');
}
