/**
 * An illustration of the product, drawn in the app's own tokens: a new lead texting in after
 * hours, the AI teammate answering and booking it, and the one message that waits for a person.
 *
 * It is a drawing, not a screenshot, and the caption says so. Replace it with a real screenshot
 * of the Inbox once the app is deployed and there is a demo business worth photographing.
 */
export function ProductMock() {
  return (
    <figure className="m-0">
      <div className="bg-card border-border rounded-[16px] border shadow-[var(--shadow-3)]">
        <div className="border-border flex items-center gap-2.5 border-b px-4 py-3">
          <span className="bg-accent-soft-2 text-accent-text flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold">
            MR
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">Marisol R.</p>
            <p className="text-text-3 truncate text-xs">New lead · texted your business number</p>
          </div>
          <span className="text-text-3 ml-auto text-xs whitespace-nowrap">7:42 PM</span>
        </div>

        <div className="space-y-3 px-4 py-4">
          <Bubble side="in">Hi — my AC is blowing warm air. Can anyone come out today?</Bubble>

          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="bg-accent text-on-solid rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold">
                Ava · AI teammate
              </span>
              <span className="text-text-3 text-[0.6875rem]">replied in 9 seconds</span>
            </div>
            <Bubble side="out">
              Sorry about that, Marisol — warm air in this heat is no fun. I can get a tech to you
              tomorrow between 8 and 10 AM, or today between 5 and 7 PM. Which suits you?
            </Bubble>
          </div>

          <Bubble side="in">Tomorrow 8–10 please</Bubble>

          <div className="border-success-text/25 bg-success-soft text-success-text flex items-center gap-2 rounded-[10px] border px-3 py-2.5 text-sm">
            <svg
              viewBox="0 0 20 20"
              className="h-4 w-4 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m4 10.5 4 4 8-9" />
            </svg>
            <span>
              <strong className="font-semibold">Booked</strong> · Tue 8:00–10:00 AM · Dale ·
              Diagnostic visit · reminder texts set
            </span>
          </div>
        </div>
      </div>

      {/* The thing nobody else does: it asks before it does anything it has not earned yet. */}
      <div className="bg-card border-border-strong mt-4 ml-auto w-[min(21rem,100%)] rounded-[14px] border p-4 shadow-[var(--shadow-3)] sm:-mt-8 sm:-mr-6">
        <p className="text-text-3 mb-2 text-xs font-semibold tracking-[0.12em] uppercase">
          Waiting for your OK
        </p>
        <p className="text-sm">
          Ava wants to send Marisol a $189 diagnostic quote. It has not sent a price on its own yet.
        </p>
        <div className="mt-3 flex gap-2">
          <span className="bg-accent text-on-solid rounded-[8px] px-3 py-1.5 text-sm font-semibold">
            Send it
          </span>
          <span className="border-border-strong rounded-[8px] border px-3 py-1.5 text-sm font-semibold">
            Edit
          </span>
        </div>
      </div>

      <figcaption className="text-text-3 mt-5 text-sm">
        An illustration of a HandsFreeOS inbox. Names and messages are made up.
      </figcaption>
    </figure>
  );
}

function Bubble({ side, children }: { side: 'in' | 'out'; children: React.ReactNode }) {
  const isIn = side === 'in';
  return (
    <div className={isIn ? 'flex' : 'flex justify-end'}>
      <p
        className={[
          'max-w-[85%] rounded-[14px] px-3.5 py-2.5 text-sm',
          isIn
            ? 'bg-card-2 text-text rounded-bl-[4px]'
            : 'bg-accent text-on-solid rounded-br-[4px]',
        ].join(' ')}
      >
        {children}
      </p>
    </div>
  );
}
