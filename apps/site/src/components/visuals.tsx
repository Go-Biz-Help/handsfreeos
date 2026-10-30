import type { CSSProperties, ReactNode } from 'react';

/**
 * Small pictures of the product, drawn in the app's own tokens rather than screenshotted, so they
 * stay sharp, theme with the page, cost nothing to load, and never show a real customer's data.
 *
 * Each one is an illustration of something the product genuinely does. If a feature changes, change
 * the picture. They carry meaning, so each has an `aria-label` and hides its innards from a screen
 * reader — otherwise a reader would hear a soup of fragments.
 */

function Mock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="img"
      aria-label={label}
      className="bg-card border-border rounded-[16px] border p-4 shadow-[var(--shadow-2)]"
    >
      <div aria-hidden="true" className="space-y-2.5">
        {children}
      </div>
    </div>
  );
}

function Row({
  children,
  className = '',
  tone = 'plain',
}: {
  children: ReactNode;
  className?: string;
  tone?: 'plain' | 'soft' | 'accent' | 'success' | 'warning';
}) {
  const tones = {
    plain: 'bg-card border-border',
    soft: 'bg-card-2 border-border',
    accent: 'bg-accent-soft border-accent/30',
    success: 'bg-success-soft border-success-text/25',
    warning: 'bg-warning-soft border-warning-text/25',
  } as const;
  return (
    <div
      className={`flex items-center gap-2.5 rounded-[10px] border p-2.5 ${tones[tone]} ${className}`}
    >
      {children}
    </div>
  );
}

function Chip({
  children,
  tone = 'plain',
}: {
  children: ReactNode;
  tone?: 'plain' | 'accent' | 'success' | 'warning' | 'danger';
}) {
  const tones = {
    plain: 'bg-card-2 text-text-2',
    accent: 'bg-accent text-white',
    success: 'bg-success-soft text-success-text',
    warning: 'bg-warning-soft text-warning-text',
    danger: 'bg-danger-soft text-danger-text',
  } as const;
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Avatar({ initials }: { initials: string }) {
  return (
    <span className="bg-accent-soft-2 text-accent-text flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-bold">
      {initials}
    </span>
  );
}

function Line({ w = '100%', dim = false }: { w?: string; dim?: boolean }) {
  return (
    <span
      className={`block h-2 rounded-full ${dim ? 'bg-card-3' : 'bg-card-3'}`}
      style={{ width: w, opacity: dim ? 0.6 : 1 }}
    />
  );
}

/** Texts, calls and email arriving as one thread. */
export function InboxVisual() {
  return (
    <Mock label="A customer thread showing a text, a missed call and an email in one place">
      <Row>
        <Avatar initials="MR" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Marisol R.</span>
            <Chip tone="accent">New</Chip>
          </div>
          <Line w="70%" />
        </div>
        <span className="text-text-3 text-xs">7:42 PM</span>
      </Row>
      <Row tone="soft">
        <span className="text-text-3 text-xs font-semibold tracking-wide uppercase">Text</span>
        <div className="flex-1 space-y-1.5">
          <Line w="88%" />
          <Line w="54%" dim />
        </div>
      </Row>
      <Row tone="warning">
        <span className="text-warning-text text-xs font-semibold tracking-wide uppercase">
          Missed call
        </span>
        <div className="flex-1">
          <Line w="42%" dim />
        </div>
        <Chip tone="warning">Texted back</Chip>
      </Row>
      <Row tone="soft">
        <span className="text-text-3 text-xs font-semibold tracking-wide uppercase">Email</span>
        <div className="flex-1 space-y-1.5">
          <Line w="76%" />
        </div>
      </Row>
    </Mock>
  );
}

/** Leads sitting in stages you decide. */
export function PipelineVisual() {
  const columns = [
    { name: 'New', count: 4, cards: 2, tone: 'plain' as const },
    { name: 'Quoted', count: 6, cards: 3, tone: 'plain' as const },
    { name: 'Booked', count: 3, cards: 2, tone: 'success' as const },
  ];
  return (
    <Mock label="A pipeline with leads in the stages New, Quoted and Booked">
      <div className="grid grid-cols-3 gap-2">
        {columns.map((column) => (
          <div key={column.name} className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold">{column.name}</span>
              <span className="text-text-3 text-xs">{column.count}</span>
            </div>
            {Array.from({ length: column.cards }).map((_, index) => (
              <div
                key={index}
                className={`space-y-1.5 rounded-[8px] border p-2 ${
                  column.tone === 'success'
                    ? 'bg-success-soft border-success-text/20'
                    : 'bg-card-2 border-border'
                }`}
              >
                <Line w={index % 2 === 0 ? '80%' : '62%'} />
                <Line w="45%" dim />
              </div>
            ))}
          </div>
        ))}
      </div>
    </Mock>
  );
}

/** A booking page a customer fills in themselves. */
export function BookingVisual() {
  return (
    <Mock label="A public booking page with times a customer can pick">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">AC diagnostic · 1 hr</span>
        <Chip tone="success">$189</Chip>
      </div>
      <div className="grid grid-cols-4 gap-1.5 pt-1">
        {['Mon', 'Tue', 'Wed', 'Thu'].map((day, index) => (
          <div
            key={day}
            className={`rounded-[8px] border p-1.5 text-center text-xs font-semibold ${
              index === 1 ? 'bg-accent text-white border-accent' : 'bg-card-2 border-border'
            }`}
          >
            {day}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {['8:00 AM', '10:00 AM', '1:00 PM', '3:00 PM'].map((time, index) => (
          <div
            key={time}
            className={`rounded-[8px] border px-2 py-1.5 text-center text-xs ${
              index === 0
                ? 'border-accent text-accent-text bg-accent-soft font-semibold'
                : 'border-border text-text-2'
            }`}
          >
            {time}
          </div>
        ))}
      </div>
      <Row tone="success">
        <Chip tone="success">Reminder</Chip>
        <div className="flex-1">
          <Line w="60%" dim />
        </div>
      </Row>
    </Mock>
  );
}

/** An estimate approved by typing a name, and the invoice it becomes. */
export function MoneyVisual() {
  return (
    <Mock label="An estimate approved by the customer, and the invoice it becomes">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">Estimate #1042</span>
        <Chip tone="success">Approved</Chip>
      </div>
      <div className="space-y-2 pt-1">
        {[
          ['Diagnostic visit', '$189'],
          ['Capacitor', '$96'],
          ['Labor, 2 hrs', '$240'],
        ].map(([item, price]) => (
          <div key={item} className="flex items-center justify-between text-xs">
            <span className="text-text-2">{item}</span>
            <span className="font-semibold">{price}</span>
          </div>
        ))}
        <div className="border-border flex items-center justify-between border-t pt-2 text-sm">
          <span className="font-semibold">Total</span>
          <span className="font-bold">$525</span>
        </div>
      </div>
      <Row tone="soft">
        <span className="text-text-3 text-xs">Signed</span>
        <span className="text-text flex-1 text-sm italic">Marisol Vega</span>
      </Row>
      <Row tone="accent">
        <Chip tone="accent">Invoice sent</Chip>
        <div className="flex-1">
          <Line w="50%" dim />
        </div>
        <span className="text-accent-text text-xs font-semibold">Pay link</span>
      </Row>
    </Mock>
  );
}

/** Deposits, invoices and plans, paid into the business's own account rather than ours. */
export function PaymentsVisual() {
  const payments = [
    { what: 'Deposit · taken at booking', who: 'Marisol R.', amount: '$50', status: 'Paid' },
    { what: 'Invoice #1042', who: 'Marisol R.', amount: '$525', status: 'Paid' },
    { what: 'Maintenance plan', who: 'Ray K.', amount: '$29/mo', status: 'Renews Nov 1' },
  ] as const;
  return (
    <Mock label="Payments landing in the business's own Stripe or Square account: a deposit taken at booking, a paid invoice and a monthly plan">
      <div className="flex items-baseline justify-between pb-1">
        <span className="text-sm font-semibold">Payments</span>
        <span className="text-text-3 text-xs">This week</span>
      </div>
      {payments.map((payment) => (
        <Row key={payment.what} tone="soft">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold">{payment.what}</p>
            <p className="text-text-3 text-xs">{payment.who}</p>
          </div>
          <span className="text-xs font-bold tabular-nums">{payment.amount}</span>
          <Chip tone={payment.status === 'Paid' ? 'success' : 'plain'}>{payment.status}</Chip>
        </Row>
      ))}
      <Row tone="accent">
        <span className="text-accent-text text-xs font-semibold">Paid into</span>
        <span className="flex-1 text-xs font-semibold">Your own Stripe or Square account</span>
      </Row>
    </Mock>
  );
}

/**
 * A connected calendar as HandsFreeOS sees it: the times you are busy and nothing else, with its own
 * appointments written back. This is the Connected accounts promise drawn, so keep it in step with that copy.
 */
export function BusyTimesVisual() {
  const busy =
    'bg-[repeating-linear-gradient(135deg,var(--card-2)_0_6px,var(--card-3)_6px_12px)] border-border';
  return (
    <Mock label="A day in a connected calendar: other events appear only as busy times with no titles, and a HandsFreeOS appointment has been written back">
      <div className="flex items-baseline justify-between pb-1">
        <span className="text-sm font-semibold">Tuesday · your calendar</span>
        <span className="text-text-3 text-xs">as HandsFreeOS sees it</span>
      </div>
      {[
        { time: '8:00', kind: 'job' },
        { time: '10:30', kind: 'busy' },
        { time: '1:00', kind: 'busy' },
        { time: '3:00', kind: 'open' },
      ].map((slot) => (
        <div key={slot.time} className="flex items-stretch gap-2.5">
          <span className="text-text-3 w-9 shrink-0 pt-2.5 text-right text-xs tabular-nums">
            {slot.time}
          </span>
          {slot.kind === 'job' ? (
            <Row tone="accent" className="flex-1">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold">AC diagnostic · Marisol R.</p>
                <p className="text-accent-text text-xs">Written back by HandsFreeOS</p>
              </div>
            </Row>
          ) : slot.kind === 'busy' ? (
            <div
              className={`flex flex-1 items-center justify-between rounded-[10px] border px-2.5 py-2.5 ${busy}`}
            >
              <span className="bg-card text-text-2 rounded-full px-2 py-0.5 text-xs font-semibold">
                Busy
              </span>
              <span className="text-text-3 bg-card rounded-full px-2 py-0.5 text-xs">
                time only, no title
              </span>
            </div>
          ) : (
            <div className="border-border text-text-3 flex flex-1 items-center rounded-[10px] border border-dashed px-2.5 py-2.5 text-xs">
              Open · customers can book this
            </div>
          )}
        </div>
      ))}
    </Mock>
  );
}

/**
 * The lead nobody answered, as it looks on a lock screen at 8pm: drawn for the night band, so it is set in
 * the night colours in both themes. The notifications carry `rise`, so inside a `<Reveal>` they arrive one
 * after another, the way they did. The home page tells it in the visitor's own trade (content/trades.ts).
 */
export function MissedLeadVisual({
  lead = {
    name: 'Kevin M.',
    ask: 'Hi, is anyone free to look at a leaking water heater today?',
    gone: 'All good, found someone who can come tonight. Thanks anyway.',
  },
}: {
  lead?: { readonly name: string; readonly ask: string; readonly gone: string };
}) {
  const notes = [
    { app: 'Messages', time: '7:42 PM', title: lead.name, body: lead.ask },
    { app: 'Phone', time: '7:49 PM', title: 'Missed call', body: lead.name },
    { app: 'Messages', time: '8:01 PM', title: lead.name, body: lead.gone },
  ] as const;
  return (
    <div
      role="img"
      aria-label="Three notifications read too late: a new customer's text at 7:42 PM, a missed call from them at 7:49 PM, and at 8:01 PM a text saying they found someone else"
      className="mx-auto w-full max-w-[24rem]"
    >
      <div aria-hidden="true">
        <p className="text-on-night-2 mb-4 text-center text-sm">
          <span className="text-on-night text-4xl font-semibold tracking-[-0.03em] tabular-nums">
            8:04
          </span>
          <span className="mt-1 block">when you finally get to your phone</span>
        </p>
        <div className="space-y-2.5">
          {notes.map((note, index) => (
            <div
              key={note.time}
              className="rise border-night-border rounded-[18px] border bg-white/[0.07] px-4 py-3 backdrop-blur-md"
              style={{ '--i': index + 1 } as CSSProperties}
            >
              <div className="text-on-night-2 flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 font-medium">
                  <span
                    className={`h-2 w-2 rounded-full ${note.app === 'Phone' ? 'bg-danger' : 'bg-success'}`}
                  />
                  {note.app}
                </span>
                <span className="tabular-nums">{note.time}</span>
              </div>
              <p className="text-on-night mt-1.5 text-sm font-semibold">{note.title}</p>
              <p className="text-on-night-2 text-sm">{note.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The AI earning the right to send on its own. */
export function TrustLadderVisual() {
  const steps = [
    { title: 'It drafts, you send', detail: 'Every message waits for a person', state: 'done' },
    {
      title: 'You approve, again and again',
      detail: '12 of this kind, all approved',
      state: 'done',
    },
    { title: 'It sends this kind on its own', detail: 'And you can take it back', state: 'now' },
    { title: 'Prices', detail: 'Still locked until you say so', state: 'off' },
  ] as const;
  return (
    <Mock label="The AI teammate moving from drafting to sending on its own, with prices still locked">
      {steps.map((step) => (
        <Row key={step.title} tone={step.state === 'now' ? 'accent' : 'soft'}>
          <span
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-bold ${
              step.state === 'off'
                ? 'bg-card-3 text-text-3'
                : step.state === 'now'
                  ? 'bg-accent text-white'
                  : 'bg-success-soft text-success-text'
            }`}
          >
            {step.state === 'off' ? '·' : '✓'}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold">{step.title}</p>
            <p className="text-text-3 text-xs">{step.detail}</p>
          </div>
        </Row>
      ))}
    </Mock>
  );
}

/** Asking for something, and being shown what it will do first. */
export function AssistantVisual() {
  return (
    <Mock label="The Assistant being asked to text everyone whose service is due, and showing a confirm card first">
      <Row tone="soft">
        <span className="text-text-3 text-xs font-semibold">You</span>
        <p className="text-text flex-1 text-xs">“Text everyone whose service is due this month.”</p>
      </Row>
      <div className="border-accent/30 bg-accent-soft space-y-2 rounded-[10px] border p-2.5">
        <p className="text-accent-text text-[0.6875rem] font-semibold tracking-[0.1em] uppercase">
          Before I send
        </p>
        <div className="flex items-center justify-between text-xs">
          <span className="text-text-2">People</span>
          <span className="font-semibold">38 customers</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-text-2">Message</span>
          <span className="font-semibold">Service due, book here</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-text-2">When</span>
          <span className="font-semibold">Weekdays, 9am–5pm</span>
        </div>
        <div className="flex gap-1.5 pt-1">
          <span className="bg-accent text-white rounded-[8px] px-2.5 py-1 text-xs font-semibold">
            Send
          </span>
          <span className="border-border-strong rounded-[8px] border px-2.5 py-1 text-xs font-semibold">
            Change it
          </span>
        </div>
      </div>
    </Mock>
  );
}

/** A follow-up that runs itself, and branches on the reply. */
export function WorkflowVisual() {
  return (
    <Mock label="A workflow: a new lead, a wait, a text, then the AI sorting the reply into branches">
      <Row tone="accent">
        <Chip tone="accent">Trigger</Chip>
        <span className="text-xs font-semibold">A new lead comes in</span>
      </Row>
      <div className="text-text-3 pl-4 text-xs">↓ wait 2 minutes</div>
      <Row tone="soft">
        <Chip>Text</Chip>
        <div className="flex-1">
          <Line w="72%" dim />
        </div>
      </Row>
      <div className="text-text-3 pl-4 text-xs">↓ AI reads the reply</div>
      <div className="grid grid-cols-2 gap-1.5">
        {[
          ['Emergency', 'danger'],
          ['Wants to book', 'success'],
          ['Question', 'plain'],
          ['Something else', 'plain'],
        ].map(([name, tone]) => (
          <div
            key={name}
            className="border-border bg-card-2 flex items-center justify-center rounded-[8px] border px-2 py-1.5"
          >
            <Chip tone={tone as 'danger' | 'success' | 'plain'}>{name}</Chip>
          </div>
        ))}
      </div>
    </Mock>
  );
}

/** What needs a person today, money first. */
export function ActionCenterVisual() {
  const items = [
    { name: 'Marisol V.', why: 'Hot lead · waiting 11 min', money: '$7,425', tone: 'danger' },
    { name: 'Ray K.', why: 'Wants to move Thursday', money: '$480', tone: 'warning' },
    { name: 'Dana P.', why: 'Invoice 10 days late', money: '$1,190', tone: 'warning' },
    { name: 'Handled for you', why: '3 reminders sent', money: '', tone: 'success' },
  ] as const;
  return (
    <Mock label="A ranked list of what needs attention, with the money affected beside each one">
      <div className="flex items-baseline justify-between pb-1">
        <span className="text-lg font-bold">$11,535</span>
        <span className="text-text-3 text-xs">6 need you · 2 urgent</span>
      </div>
      {items.map((item) => (
        <Row key={item.name} tone={item.tone === 'success' ? 'success' : 'soft'}>
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              item.tone === 'danger'
                ? 'bg-danger'
                : item.tone === 'warning'
                  ? 'bg-warning'
                  : 'bg-success'
            }`}
          />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold">{item.name}</p>
            <p className="text-text-3 text-xs">{item.why}</p>
          </div>
          {item.money ? <span className="text-xs font-bold">{item.money}</span> : null}
        </Row>
      ))}
    </Mock>
  );
}

/** Moving in: counted first, joined without guessing, and reversible. */
export function MigrationVisual() {
  return (
    <Mock label="A migration counting what is there before it moves anything, and offering to undo it">
      <div className="grid grid-cols-3 gap-2">
        {[
          ['1,284', 'customers'],
          ['3,112', 'messages'],
          ['418', 'appointments'],
        ].map(([count, what]) => (
          <div key={what} className="bg-card-2 border-border rounded-[8px] border p-2 text-center">
            <p className="text-sm font-bold">{count}</p>
            <p className="text-text-3 text-[0.6875rem]">{what}</p>
          </div>
        ))}
      </div>
      <Row tone="success">
        <Chip tone="success">Joined</Chip>
        <span className="text-text-2 flex-1 text-xs">
          14 people who arrived twice, matched on number
        </span>
      </Row>
      <Row tone="soft">
        <Chip>Kept</Chip>
        <span className="text-text-2 flex-1 text-xs">History on the dates it really happened</span>
      </Row>
      <Row tone="soft">
        <Chip>Undo</Chip>
        <span className="text-text-2 flex-1 text-xs">Puts it back, without touching new work</span>
      </Row>
    </Mock>
  );
}
