/**
 * The ticket a call carries to the AI teammate's stream (M18 step 5). Twilio opens the websocket with no
 * signature we can check against a known URL and body, so the TwiML that sends the call there puts a sealed
 * ticket in the stream's parameters: which business, which call, the number called and who is calling, and
 * when it stops being good. Only the worker can seal one, and a stream without a good one is closed.
 */
import type { Sealer } from '../crypto';

/** A ticket is good for this long: the call connects to the stream within seconds of the TwiML. */
export const TICKET_TTL_MS = 2 * 60_000;

export interface StreamTicket {
  readonly workspaceId: string;
  readonly organizationId: string;
  /** Twilio's call sid. */
  readonly callSid: string;
  /** The business number they called. */
  readonly line: string;
  /** Who is calling (on a call the teammate placed: who it called). */
  readonly from: string;
  /** AI outbound calls: the call the teammate placed (app.ai_calls), or absent when it's answering one. */
  readonly aiCallId?: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

export function sealTicket(sealer: Sealer, t: Omit<StreamTicket, 'expiresAt'>, now = Date.now()) {
  return sealer.seal(
    JSON.stringify({
      w: t.workspaceId,
      o: t.organizationId,
      c: t.callSid,
      l: t.line,
      f: t.from,
      ...(t.aiCallId ? { a: t.aiCallId } : {}),
      e: now + TICKET_TTL_MS,
    }),
  );
}

/** The ticket, or null when it's forged, damaged, or too old. */
export function openTicket(
  sealer: Sealer,
  sealed: string | undefined,
  now = Date.now(),
): StreamTicket | null {
  if (!sealed) return null;
  try {
    const v = JSON.parse(sealer.open(sealed)) as Record<string, unknown>;
    const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : null);
    const [w, o, c, l, f] = [str('w'), str('o'), str('c'), str('l'), str('f')];
    const e = typeof v['e'] === 'number' ? v['e'] : 0;
    if (!w || !o || !c || !l || !f || e < now) return null;
    const a = str('a');
    return {
      workspaceId: w,
      organizationId: o,
      callSid: c,
      line: l,
      from: f,
      ...(a ? { aiCallId: a } : {}),
      expiresAt: e,
    };
  } catch {
    return null;
  }
}

/**
 * A live test call's ticket (the test console over the phone line, ai-team/test-call.ts). The console gets one to
 * place its call with; the browser call carries it to the TwiML, which seals another for the stream, bound to the
 * call's sid. Either names the test call, who is placing it and where, and the machine holding the console's end
 * of it. A real call's ticket never opens as one of these, nor one of these as a real call's.
 */
export interface TestCallTicket {
  readonly workspaceId: string;
  readonly organizationId: string;
  /** Who is testing. */
  readonly userId: string;
  readonly testCallId: string;
  /** The worker machine the console is connected to (FLY_MACHINE_ID, or `local`). */
  readonly machine: string;
  /** The stream's ticket: the call it's for. The dial ticket has none yet. */
  readonly callSid: string | null;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

/** How long the console has to place its call with a dial ticket. */
export const TEST_DIAL_TTL_MS = 60_000;

export function sealTestTicket(
  sealer: Sealer,
  t: Omit<TestCallTicket, 'expiresAt'>,
  ttlMs = t.callSid ? TICKET_TTL_MS : TEST_DIAL_TTL_MS,
  now = Date.now(),
): string {
  return sealer.seal(
    JSON.stringify({
      k: 'test',
      w: t.workspaceId,
      o: t.organizationId,
      u: t.userId,
      i: t.testCallId,
      m: t.machine,
      ...(t.callSid ? { c: t.callSid } : {}),
      e: now + ttlMs,
    }),
  );
}

/** The test call's ticket, or null when it's forged, damaged, too old, or not a test call's. */
export function openTestTicket(
  sealer: Sealer,
  sealed: string | undefined,
  now = Date.now(),
): TestCallTicket | null {
  if (!sealed) return null;
  try {
    const v = JSON.parse(sealer.open(sealed)) as Record<string, unknown>;
    const str = (k: string) => (typeof v[k] === 'string' && v[k] ? (v[k] as string) : null);
    const [w, o, u, i, m] = [str('w'), str('o'), str('u'), str('i'), str('m')];
    const e = typeof v['e'] === 'number' ? v['e'] : 0;
    if (v['k'] !== 'test' || !w || !o || !u || !i || !m || e < now) return null;
    return {
      workspaceId: w,
      organizationId: o,
      userId: u,
      testCallId: i,
      machine: m,
      callSid: str('c'),
      expiresAt: e,
    };
  } catch {
    return null;
  }
}
