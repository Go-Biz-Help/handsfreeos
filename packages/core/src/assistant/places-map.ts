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
      'A new business sees Finish setting up instead: Confirm your email, Create your business, Invite your team, Add a passkey, Connect Google sign-in',
    ],
    howTo: [
      'Let HandsFreeOS deal with an item: press Let HandsFreeOS Handle on it',
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
    label: 'Inbox',
    what: 'every conversation with customers: texts, calls, email and website chat',
    where: ['Inbox'],
    onScreen: [
      'New message, at the top (it starts a text to someone already in Customers)',
      'Mine, Unassigned, and All (Everyone when each person sees only their own); Needs a person and the AI teammate’s own box when it is on',
      'Search conversations (names, numbers and words in messages), and Open, Snoozed, Closed or Archived',
    ],
    howTo: [
      'Text a customer who hasn’t written in: Inbox, press New message, pick them in To, then Open conversation',
      'Email someone new: open their page in Customers and press Email (New message only starts texts)',
      'Find an archived conversation: Inbox, then Archived in the status picker',
      'See what the AI teammate handed over: Inbox, Needs a person',
    ],
    canChange: ['find closed, snoozed, archived, Needs a person and AI-teammate conversations'],
    path: '/inbox',
  },
  {
    label: 'A conversation',
    what: 'one customer’s texts, calls and emails, the reply box, and their details beside it',
    where: ['Inbox'],
    then: 'press the conversation',
    onScreen: [
      'At the top: which line to answer on, Assign, Snooze, Close (or Reopen), Customer details, and ⋯ with Call, Open customer (or Add as a new person), Hand to (the AI teammate’s name), Mark as unread, Close every line, Copy phone number, Archive this conversation',
      'Banners when the AI teammate has it: Take over, Take it, or Hand back',
      'The AI teammate’s drafts in the thread: Approve and send, Edit, Reject…',
      'The reply box: Text or Email, Cc and Subject for email, the paperclip for a photo or file, Insert a template, Add buttons or a card, then Send text or Send email; in quiet hours it offers Send at the time they end',
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
      'Save a stranger as a customer: type their name beside the conversation and press Add customer, or link them to an existing one',
      'Move their lead’s stage, book them, add a task or quote them: in the panel beside the conversation',
      'Mark it unread: ⋯, then Mark as unread',
      'Archive it: ⋯, then Archive this conversation (Bring it back undoes it)',
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
    ],
    path: '/inbox/[conversationId]',
  },
  {
    label: 'Customers',
    what: 'people, companies and the business’s own kinds of records',
    where: ['Customers'],
    onScreen: [
      'Tabs: People, Companies, and any kinds of records of your own',
      'Import and Add person (Add company on Companies), at the top',
      'Search by name, phone, email or street; Any tag; Assigned to anyone; Show archived',
    ],
    howTo: [
      'Add a customer: Customers, press Add person, then Save person (it warns when they may already be there)',
      'Add a company: Customers → Companies, press Add company',
      'Import a spreadsheet: Customers, press Import (the same as Settings → Imports)',
      'Find everyone with a tag: Customers, then Any tag',
      'Bring back an archived customer: Customers, Show archived, press them, then ⋯ and Restore',
      'Search from anywhere: Search customers at the top of the side menu',
    ],
    notHere: [
      'merging two customers (adding one warns about a likely duplicate, with Open or Save anyway)',
      'deleting a customer for good (archive them)',
      'choosing many customers at once to tag, assign or archive (the Assistant can tag many at once)',
      'exporting customers to a spreadsheet',
    ],
    canChange: [
      'add a company and change its details',
      'archive and bring back a customer or company (owners and admins)',
      'find archived customers, companies, leads and records',
    ],
    path: '/customers',
  },
  {
    label: 'A customer’s page',
    what: 'one person: everything the business has done with them (a company’s page is the same, without calling, texting, booking or money)',
    where: ['Customers'],
    then: 'press the person',
    onScreen: [
      'At the top: their tags (Add tag, or + to change them), and ⋯ with Edit details and Archive',
      'Along the top: Call, Text, Email, Book, Note, Log call, Task, Lead, File, and Add to workflow…',
      'Tabs: Timeline, Appointments, Money, Leads, Tasks, Files, Details (Details has Edit, Calls from us, and their Fields)',
      'Beside them: Assigned to, Upcoming appointments, Regular services, Conversations, Workflows, Open lead, Relationships',
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
      'Write them an estimate or invoice: their page, Money tab, New estimate or New invoice',
      'Put them on a maintenance plan: their page, Money tab, Put on a plan',
      'Put them on a workflow: their page, press Add to workflow…, pick one, then Add (their name); only published workflows that start By hand are offered',
      'Take them off a workflow: their page, the Workflows card, Remove',
      'Choose who looks after them: their page, the Assigned to card',
      'Link a pet, vehicle or property: their page, the Relationships card, Add',
      'Record whether they agreed to calls: their page, Details tab, Change beside Calls from us',
      'Archive them: their page, ⋯, then Archive',
    ],
    canChange: [
      'choose who looks after them: add, take off, make main (owners and admins)',
      'record that they agreed in writing to calls (and where), or don’t want calls; record that they don’t want texts',
      'delete a file on their record',
      'add their pets, vehicles or properties, change them, and relate records',
      'put them on a maintenance plan',
    ],
    path: '/customers/people/[personId]',
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
      'Add a lead: Pipeline, press New lead, pick the customer (they need to be in Customers first), then Create lead',
      'Move a lead: drag it on the board, change Stage in the list, or press a stage on the lead',
      'Switch pipeline: the picker at the top of Pipeline',
    ],
    notHere: [
      'searching or filtering the board',
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
      'Note, Log call, Won and Lost (Reopen once closed); ⋯ has Edit details and Archive lead',
      'Its full page adds Book, File, Add to workflow…, Qualification, Money (New estimate), Upcoming appointments and Workflows',
    ],
    howTo: [
      'Mark a lead won: press Won on it',
      'Mark it lost: press Lost, pick why, then Mark as lost',
      'Set a follow-up: type it in the next action box and press Set, or Change to move it',
      'Change its value, owner or close date: ⋯, then Edit details',
      'Quote a lead: Open full page, then New estimate in its Money card',
      'Book it: Open full page, then Book',
    ],
    notHere: ['deleting a lead (archive it)'],
    canChange: ['archive it and bring it back (owners and admins)'],
    path: '/leads/[leadId]',
  },
  {
    label: 'Calendar',
    what: 'the appointments',
    where: ['Calendar'],
    onScreen: [
      'New appointment, and Manage calendars (which opens Settings → Calendars)',
      'Today and the arrows; Day, Week, Month, Team and Resources; the Person picker; a chip for each calendar to show or hide it',
      'Press an empty time to book there; drag an appointment to move it, or its bottom edge to change its length',
    ],
    howTo: [
      'Book an appointment: Calendar, press New appointment (or an empty time), fill in Customer, Calendar, Service, With, Date, Start, Length and Location, then Book; untick Tell (their name) to book without messaging them',
      'See one person’s week: Calendar, Week, then pick them in Person',
      'Book repeat visits: in New appointment, pick Every week, Every 2 weeks or Every month under Repeats and how many visits, then Book; Repeats shows when the calendar’s Repeats section has Staff can repeat visits on, and dates that don’t fit are listed, not booked',
    ],
    notHere: [
      'adding a new customer from the booking box (add them in Customers first)',
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
      'Seats, for group sessions: Add',
      'Where: Directions',
      'People and equipment: Change',
      'Reminders (what went out, and when), and anything else on this visit',
      'Job: Scheduled, On the way, Started, Waiting on parts, Done (each texts the customer); Note the customer may see',
      'At the bottom: Reschedule, Complete, No-show, Invoice this visit, Cancel',
    ],
    howTo: [
      'Move it: open it and press Reschedule, or drag it on the calendar',
      'Give it to someone else: open it, press Change under People and equipment',
      'Cancel it: open it, press Cancel, choose whether to tell the customer and give a reason, then Cancel appointment',
      'Mark it done or a no-show: open it, press Complete or No-show (the other one is offered afterwards to undo it)',
      'Tell the customer you are on the way: open it, press On the way under Job',
      'Bill the visit: open it, press Invoice this visit',
    ],
    notHere: [
      'changing the customer or service after booking',
      'deleting an appointment (cancel it)',
    ],
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
      'change a draft estimate or invoice',
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
      'Record cash or a cheque: Money → Invoices, press the invoice, then Record a payment',
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
      'turn it into an invoice, the whole job or just the deposit',
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
      'Who is on a plan; pressing someone opens their plan: Ask for a new card, Copy link, Pause (or Start it again), Cancel the plan',
    ],
    howTo: [
      'Put a customer on a plan: Money → Plans, press Put someone on a plan, pick the customer, the plan and the account, then Start the plan, and send them the link from their plan',
      'Pause or cancel someone’s plan: Money → Plans, press them, then Pause or Cancel the plan',
      'Change the card on a plan: press them, then Ask for a new card',
      'Make a new plan to sell: Money → Plans, press New plan, then Add plan (whoever manages money)',
      'Change a plan’s price or what it includes: Money → Plans, press its name, then Save; people already on it keep what they signed up for',
      'Stop selling a plan: press its name, then Stop selling it; anyone on it stays on it',
      'Put one customer on a plan from their page: their Money tab, Put on a plan',
    ],
    canChange: [
      'put a customer on a plan and send them the card link',
      'pause, restart or cancel someone’s plan, or ask them for a new card',
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
      'New workflow, at the top: a recipe, Describe it, or Start blank',
      'Search workflows; All, Active, Paused, Drafts; an On or off switch on each',
    ],
    howTo: [
      'Start a workflow: Workflows, press New workflow, pick a recipe (or Describe it, or Start blank), name it, then Create draft',
      'Pause one: its On or off switch in the list, or Pause in the workflow',
      'Retry a failed step: Workflows → Runs, press the run, then Retry (or Skip)',
      'Approve what a workflow wrote: Workflows → Approvals, press Review, then Approve and send',
    ],
    notHere: [
      'deleting, copying or bringing back an archived workflow',
      'putting many customers on a workflow at once (one at a time from their page)',
    ],
    canChange: [
      'rename a workflow or change its description',
      'archive one',
      'stop a run, or retry or skip the step it failed on',
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
      'The + between steps adds one: texts and emails, the customer, the lead, tasks, the conversation, other workflows, Wait, If / else, Split into paths, AI step and Approval',
    ],
    howTo: [
      'Change what starts it: open it, Steps, press the When card at the top',
      'Start one when an estimate goes out, is approved or declined, an invoice is paid or overdue, a form is answered, or the AI teammate hands over: the When card, Event, then Money, Forms, or Messages and calls',
      'Add a step: press the + between two steps',
      'Delete, copy or move a step: press the step, then its ⋯',
      'Stop it when the customer replies: Settings, then Stop the run when they, Reply by text or email',
      'Let someone go through it only once: Settings, Only once, ever',
      'Test it: Test, then Run test',
      'Publish it: fix what Checks marks red, run a test, then Publish',
      'Go back to an older version: History, Restore, then test and publish again',
      'Rename it: press its name at the top',
    ],
    canChange: [
      'rename it or archive it; testing, publishing and bringing back an older version stay yours',
    ],
    path: '/workflows/[workflowId]',
  },
  {
    label: 'Campaigns',
    what: 'one-off outreach by text, email or calls, written by the AI and approved by a person',
    where: ['Campaigns'],
    onScreen: [
      'New campaign: Send as (Texts, Email or Calls), Name, About an offer?, What’s it for?, Who gets it (tags and pipeline stages), and how many an hour; then Write the texts',
      'A campaign in review: each message can be edited or removed, then Approve all and send',
      'Once it is going: Pause, Resume, Stop, and Change beside the pace',
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
    ],
    path: '/campaigns',
  },
  {
    label: 'Forms',
    what: 'forms, surveys and quizzes customers fill in',
    where: ['Forms'],
    onScreen: [
      'New form: its name, Form, Survey or Quiz, or a starter; then Create',
      'A form: Questions, Preview, Results and Share, with Undo and Publish',
      'Share: Copy the link, a QR code to Download, Copy the snippet for your website, and Let the AI teammate ask it',
    ],
    howTo: [
      'Make a form: Forms, press New form, name it, pick a kind or starter, Create, add questions, then Publish',
      'Save an answer onto the customer: press the question, then Where the answer goes',
      'Send a form to a customer: its Share tab, Copy the link, and text it; or turn on Let the AI teammate ask it',
      'Put it on your website: Share, list the site under Sites allowed to show it, then Copy the snippet',
      'Download the answers: Results, Export to CSV',
    ],
    notHere: [
      'changing the thank-you message, or being emailed when someone answers',
      'showing a question only after a certain answer',
      'deleting a form for good (archive it)',
    ],
    canChange: [
      'rename, copy, archive or bring back a form',
      'change its link',
      'delete one person’s answers',
    ],
    path: '/forms',
  },
  {
    label: 'Reviews',
    what: 'Google and Facebook reviews, and answering them',
    where: ['Reviews'],
    onScreen: [
      'Google and Facebook: Connect, or Sign in again',
      'Average stars, and a filter for the unanswered ones',
      'Each review: Answer (Facebook reviews are answered on Facebook)',
    ],
    howTo: [
      'Answer a review: Reviews, press Answer on it, write, then Answer',
      'Ask customers for reviews: Workflows, New workflow, the recipe Appointment follow-up + review; the link it sends is Review link on Settings → Workspace',
    ],
    notHere: [
      'asking for reviews from this page (a workflow does it)',
      'editing or deleting an answer once it’s posted',
      'answering a Facebook review here (that’s done on Facebook)',
    ],
    canChange: ['answer a Google review (it’s public)'],
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
      'Add a task about a customer or lead: from their page, Task (New task on the Tasks page can’t attach one)',
      'Tick a task off: press its circle (Recently done has the ones to undo)',
      'Change or delete a task: its ⋯, then Edit or Delete',
    ],
    notHere: ['repeating tasks, priorities or subtasks', 'searching tasks'],
    path: '/tasks',
  },
  {
    label: 'Audit log',
    what: 'who changed what, and when',
    where: ['Audit log'],
    onScreen: [
      'Today, 7 days or 30 days; Filter by person (a person, workflows, the AI teammate or HandsFreeOS); Filter by activity; a search',
      'Press an entry to see what it was before and after, and why',
    ],
    howTo: [
      'See what someone changed: Audit log, pick them in Filter by person, then press an entry',
      'See what the AI teammate did: Audit log, Filter by person, then the AI teammate',
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
      'Share an idea, at the top; search, sort and filters; a vote on each',
      'An idea: vote, comment, Edit your idea, and Email me updates',
    ],
    howTo: [
      'Suggest something: Ideas, press Share an idea',
      'Follow an idea: open it, turn on Email me updates',
    ],
    canChange: [
      'find ideas and read one with its comments',
      'share an idea, vote or take a vote back, comment, and follow one or stop',
    ],
    notHere: ['deleting an idea once shared'],
    path: '/ideas',
  },
  {
    label: 'Agency area',
    what: 'for the agency that runs several businesses: client businesses, workflow templates, knowledge packs and migrations',
    where: [],
    then: 'press the business name at the top of the side menu, then Agency area (agency owners and admins only)',
    onScreen: [
      'Client businesses, Templates, Knowledge packs, Migrations',
      'Templates: New template, Save a workflow as a template, and Push… on each',
      'Knowledge packs: New pack, then Edit and Push on each',
    ],
    howTo: [
      'Send a workflow to client businesses: Agency area, Templates, Push… on the template, pick the businesses, match the details, then Push',
      'Send starter FAQs to client businesses: Agency area, Knowledge packs, New pack, Save pack, then Push',
    ],
    canChange: [
      'see the client businesses, templates and knowledge packs, and which businesses have a template',
      'push a published template or a knowledge pack to client businesses',
    ],
    path: '/app/org/[orgId]/templates',
  },
];

/** What is on every page, around the page itself. */
export const EVERY_PAGE: readonly string[] = [
  'Top of the side menu: the business name (press it to switch businesses, Create workspace to add one, or the Agency area), Search customers (it searches customers only), and Ask HandsFreeOS (⌘J or Ctrl J), which is you',
  'Bottom of the side menu: Turn on calls in this browser (then Calls ring in this browser), Get help (In a few words, What happened?, then Send it; a person at HandsFreeOS answers), and Sign out',
  'Each person can reorder, group or hide places in their side menu (Settings → Account, under Side menu); a place may be inside a group called More; Home and Settings never hide',
  'A place their role doesn’t allow isn’t in their side menu at all: Inbox, Money and Audit log need their own permission',
  'You can send the Get help message for them, and add a business the way Create workspace does (organization owners and admins)',
];

/** What people ask for that HandsFreeOS doesn’t do anywhere, so the Assistant says so plainly. */
export const NOT_ANYWHERE: readonly string[] = [
  'merging duplicate customers',
  'deleting a customer, company or lead for good (they are archived)',
  'choosing many rows of a list at once to change them together (the Assistant can tag many customers at once)',
  'exporting customers, leads or the audit log to a spreadsheet (form answers do have Export to CSV)',
  'a keypad to ring any number (calls start from a customer, a conversation or an item on Home)',
];

/** The phone app, which does less than the web. */
export const PHONE_APP: readonly string[] = [
  'The bar along the bottom: Home, Inbox, Pipeline, Calendar and More',
  'More: Customers, Tasks, Money, Forms, Approvals, Test your AI teammate, Settings, Ideas, Get help, and Open on the web',
  'Its Settings: My cell phone, unlocking with Face ID or a fingerprint, Businesses on this phone, Usage & balance, Notifications, Appearance, Sign out, Delete my account',
  'Only on the web: workflows, the AI teammate’s settings, Knowledge, members, the business’s settings and the agency area (More, then Open on the web)',
];

/** What customers see, and where the business manages it, for "can my customer…" questions. */
export const CUSTOMER_PAGES: readonly string[] = [
  'The booking page: set up on Settings → Calendars → Booking site; each calendar’s own link is on Settings → Calendars',
  'The link in a booking confirmation lets the customer Confirm, Reschedule, Cancel or Book again, as each calendar’s Cancel & reschedule rules allow',
  'An estimate’s page: the customer approves it by typing their name, and can print it or save a PDF',
  'An invoice’s page: the customer pays by card or bank transfer, and can print it or save a PDF',
  'A plan’s page: the customer adds the card the plan bills',
  'A form’s link, from the form’s Share tab',
  'All of them can be on the business’s own web address (Settings → Workspace)',
];

/**
 * The same word in more than one place. These are the ones people get sent to the wrong screen for, so the prompt
 * says each of them outright.
 */
export const LOOK_ALIKES: readonly string[] = [
  'Service area: the territories that route bookings and that the AI teammate checks are Settings → Calendars → Territories; each calendar only uses them once Route by ZIP code is on in its own Territories section; the words the AI says about the area are Knowledge → Overview, in Business profile under Where and when (Service area).',
  'Hours: the business’s open hours are Settings → Workspace (Business hours); a person’s own are Settings → My calendar (Weekly hours); a calendar’s are its Availability section; the AI teammate’s are its Hours section.',
  'Notifications: what a person is told about is Settings → Account (Notifications); what customers get about a booking is the calendar’s Notifications section; reminders and follow-ups HandsFreeOS sends by itself are Settings → Automations.',
  'Quiet hours: only Settings → Texting & calls, in Texting rules.',
  'Deposits: the default for estimates is Settings → Payments (Deposits); a deposit taken at booking is the calendar’s Payments section; one estimate’s own is its Deposit card.',
  'Payments: getting paid by customers is Settings → Payments; paying HandsFreeOS for texts and calls is Settings → Usage & balance; the money itself is Money; one payment’s refund is on its invoice.',
  'Approvals: what the AI teammate and workflows wrote waits in Workflows → Approvals (the AI teammate’s alone are also AI teammate → Approvals).',
  'Templates: saved texts and emails are Settings → Templates; workflow templates for many businesses are the Agency area.',
  'Team, teammates, staff: the side menu calls it Members.',
  'Connecting Google or Outlook: a calendar is Settings → My calendar; a mailbox is Settings → Email; signing in with Google is Settings → Account; Google reviews are Reviews.',
];

const trail = (where: readonly string[]) => where.join(' → ');

/** How a place is reached, in words: "Money → Invoices, then press the invoice". */
export const placeWay = (p: AppPlace): string =>
  p.where.length ? (p.then ? `${trail(p.where)}, then ${p.then}` : trail(p.where)) : (p.then ?? '');

/** The places, the page around them, the phone and what customers see, for the fixed part of the prompt. */
export function placesText(): string {
  return [
    ...APP_PLACES.map((p) => {
      const how = p.howTo.length ? ` How to: ${p.howTo.join('; ')}.` : '';
      const can = p.canChange?.length ? ` You can: ${p.canChange.join('; ')}.` : '';
      const not = p.notHere?.length ? ` Not in HandsFreeOS: ${p.notHere.join('; ')}.` : '';
      return `- ${p.label} is at ${placeWay(p)}: ${p.what}. On it: ${p.onScreen.join('; ')}.${how}${can}${not}`;
    }),
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
