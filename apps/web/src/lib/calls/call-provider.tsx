'use client';
import { formatPhone } from '@hfos/core';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { voiceToken, type VoiceToken } from '@/lib/api/worker';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { CallsUnsupportedError, createDevice, type VoiceCall, type VoiceDevice } from './device';
import { firstNameOf } from './format';

/**
 * checking: asking the worker whether calls work here; unavailable: no business number yet (or no access);
 * error: the worker couldn't say (out of reach, or calls still being set up), so the control shows why and
 * retries; off: this browser hasn't turned calls on; ready: it rings; blocked: the microphone is blocked.
 */
export type CallsReadiness =
  'checking' | 'unavailable' | 'error' | 'off' | 'starting' | 'ready' | 'blocked';

export interface CallParty {
  readonly name: string;
  readonly firstName: string;
  readonly phone: string;
  readonly personId: string | null;
}
export interface IncomingInfo {
  readonly lineName: string;
  readonly leadTitle: string;
  /** Enabled forwarding phones, "Dale’s cell and Office line". */
  readonly alsoRinging: string;
  /** Teammates whose browsers ring too (everyone who uses the inbox, minus you). */
  readonly otherTeammates: number;
}
export type CallView =
  | { readonly phase: 'idle' }
  | { readonly phase: 'incoming'; readonly party: CallParty; readonly info: IncomingInfo }
  | {
      readonly phase: 'calling' | 'active';
      readonly party: CallParty;
      readonly direction: 'inbound' | 'outbound';
      /** When the conversation started (the timer runs from here); null until both ends connect. */
      readonly startedAt: number | null;
      readonly muted: boolean;
    };

/** Who to call: a customer (personId) or a conversation's number (conversationId). */
export interface CallTarget {
  readonly name: string;
  readonly phone: string;
  readonly personId?: string | null;
  readonly conversationId?: string | null;
  /** Every number the customer has on file (0100), so the dialer can call another one; `phone` is chosen first. */
  readonly numbers?: readonly { readonly phone: string; readonly label: string }[];
}

export interface CallsValue {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly readiness: CallsReadiness;
  /** Why calls are unavailable when readiness is `error`, in words to show. */
  readonly problem: string | null;
  /** Whether Call buttons show: the workspace has a number this person may call from. */
  readonly available: boolean;
  /** The business number customers see. */
  readonly callerId: string | null;
  readonly view: CallView;
  readonly dialer: CallTarget | null;
  enable(): Promise<boolean>;
  /** Asks the worker again after an `error`; a second failure shows its reason. */
  retry(): Promise<void>;
  openDialer(target: CallTarget): void;
  closeDialer(): void;
  placeCall(target: CallTarget): Promise<void>;
  answer(): void;
  decline(): void;
  hangUp(): void;
  toggleMute(): void;
  sendDigit(digit: string): void;
}

const IDLE: CallView = { phase: 'idle' };
const MIC_BLOCKED =
  'Your browser blocked the microphone. Allow it in the address bar, then try again.';
/** Twilio's "permission denied" and "could not get the microphone". */
const MIC_CODES = new Set([31401, 31402, 31208]);
const codeOf = (e: unknown): number =>
  typeof e === 'object' && e !== null && 'code' in e ? Number((e as { code: unknown }).code) : NaN;

const storageKey = (workspaceId: string) => `hfos.calls.${workspaceId}`;
function remembered(workspaceId: string): boolean {
  try {
    return localStorage.getItem(storageKey(workspaceId)) === 'on';
  } catch {
    return false;
  }
}
function remember(workspaceId: string): void {
  try {
    localStorage.setItem(storageKey(workspaceId), 'on');
  } catch {
    // Private windows: calls stay on for this visit only.
  }
}

type TokenCheck = { readonly token: VoiceToken } | { readonly problem: string | null };

/**
 * Asks the worker for a calling token. No business number yet (or no inbox access) is no problem: calls just
 * don't apply here. Anything else (the worker out of reach, calls still being set up) is, and says why.
 */
async function checkCalls(workspaceId: string): Promise<TokenCheck> {
  try {
    return { token: await voiceToken(workspaceId) };
  } catch (e) {
    const notHere =
      e instanceof ApiError && (e.status === 403 || (e.status === 409 && e.rule === 'no_number'));
    return { problem: notHere ? null : errorMessage(e) };
  }
}

/** "Dale’s cell and 2 teammates", for the ringing card and the decline toast. */
export function alsoRingingText(info: IncomingInfo): string {
  const n = info.otherTeammates;
  const teammates = n > 0 ? `${n} ${n === 1 ? 'teammate' : 'teammates'}` : '';
  return [info.alsoRinging, teammates].filter(Boolean).join(' and ');
}

const CallsContext = createContext<CallsValue | null>(null);

const noop = () => undefined;
const NONE: CallsValue = {
  workspaceId: '',
  workspaceName: '',
  readiness: 'unavailable',
  problem: null,
  available: false,
  callerId: null,
  view: IDLE,
  dialer: null,
  enable: async () => false,
  retry: async () => undefined,
  openDialer: noop,
  closeDialer: noop,
  placeCall: async () => undefined,
  answer: noop,
  decline: noop,
  hangUp: noop,
  toggleMute: noop,
  sendDigit: noop,
};

export function useCalls(): CallsValue {
  return useContext(CallsContext) ?? NONE;
}

/**
 * Calls in the browser for one workspace: turns this browser into a phone once someone says so (and on
 * later visits), rings for the business number, places calls, and keeps the call going while people move
 * around the app (it lives in the workspace layout).
 */
export function CallProvider({
  workspaceId,
  workspaceName,
  children,
}: {
  workspaceId: string;
  workspaceName: string;
  children: ReactNode;
}) {
  const [readiness, setReadiness] = useState<CallsReadiness>('checking');
  const [problem, setProblem] = useState<string | null>(null);
  const [callerId, setCallerId] = useState<string | null>(null);
  const [view, setViewState] = useState<CallView>(IDLE);
  const [dialer, setDialer] = useState<CallTarget | null>(null);
  const viewRef = useRef<CallView>(IDLE);
  const deviceRef = useRef<VoiceDevice | null>(null);
  const callRef = useRef<VoiceCall | null>(null);
  const tokenRef = useRef<VoiceToken | null>(null);
  // A number bought (or released) elsewhere changes whether calls work here.
  const numbers = useLiveVersion(['phone_number']);

  const setView = useCallback((next: CallView | ((v: CallView) => CallView)) => {
    const value = typeof next === 'function' ? next(viewRef.current) : next;
    viewRef.current = value;
    setViewState(value);
  }, []);

  const freshToken = useCallback(async (): Promise<VoiceToken> => {
    const t = tokenRef.current;
    if (t && Date.parse(t.expiresAt) - Date.now() > 5 * 60_000) return t;
    const next = await voiceToken(workspaceId);
    tokenRef.current = next;
    setCallerId(next.callerId);
    return next;
  }, [workspaceId]);

  /** Either side hung up: the bar goes and says where the call was saved. */
  const finish = useCallback(
    (call: VoiceCall) => {
      if (callRef.current !== call) return;
      callRef.current = null;
      const v = viewRef.current;
      setView(IDLE);
      if (v.phase === 'active' && v.startedAt)
        toast.success(
          v.party.personId
            ? `Call saved to ${v.party.firstName}’s timeline`
            : 'Call saved to the conversation',
        );
      else if (v.phase === 'calling') toast(`${v.party.firstName} didn’t pick up.`);
    },
    [setView],
  );

  const fail = useCallback(
    (call: VoiceCall | null, err: unknown) => {
      if (call && callRef.current !== call) return;
      callRef.current = null;
      setView(IDLE);
      if (MIC_CODES.has(codeOf(err))) {
        setReadiness('blocked');
        toast.error(MIC_BLOCKED);
      } else toast.error('The call dropped. Try again in a moment.');
    },
    [setView],
  );

  const onIncoming = useCallback(
    (call: VoiceCall) => {
      // Already on a call: let this one ring for everyone else.
      if (viewRef.current.phase !== 'idle') {
        call.ignore();
        return;
      }
      const p = call.customParameters;
      const phone = p.get('from') || call.parameters['From'] || '';
      const name = p.get('callerName') || (phone ? formatPhone(phone) : 'Unknown caller');
      const teammates = Number(p.get('teammates') ?? '1') || 1;
      callRef.current = call;
      setView({
        phase: 'incoming',
        party: { name, firstName: firstNameOf(name), phone, personId: p.get('personId') || null },
        info: {
          lineName: p.get('lineName') || workspaceName,
          leadTitle: p.get('leadTitle') ?? '',
          alsoRinging: p.get('alsoRinging') ?? '',
          otherTeammates: Math.max(0, teammates - 1),
        },
      });
      // The caller hung up, or a teammate took it: the card just goes.
      call.on('cancel', () => {
        if (callRef.current !== call) return;
        callRef.current = null;
        setView(IDLE);
      });
      call.on('accept', () =>
        setView((v) =>
          v.phase === 'active' && !v.startedAt ? { ...v, startedAt: Date.now() } : v,
        ),
      );
      call.on('disconnect', () => finish(call));
      call.on('error', (err) => fail(call, err));
    },
    [fail, finish, setView, workspaceName],
  );

  const enable = useCallback(async (): Promise<boolean> => {
    if (deviceRef.current) return true;
    setReadiness('starting');
    try {
      const token = await freshToken();
      const device = await createDevice(token);
      device.on('incoming', onIncoming);
      device.on('tokenWillExpire', () => {
        void voiceToken(workspaceId)
          .then((t) => {
            tokenRef.current = t;
            device.updateToken(t.token);
          })
          .catch(() => undefined);
      });
      device.on('error', (err) => {
        if (MIC_CODES.has(codeOf(err))) setReadiness('blocked');
      });
      await device.register();
      deviceRef.current = device;
      setReadiness('ready');
      remember(workspaceId);
      return true;
    } catch (e) {
      const refused = e instanceof ApiError && (e.status === 403 || e.status === 409);
      setReadiness(refused || e instanceof CallsUnsupportedError ? 'unavailable' : 'off');
      toast.error(
        e instanceof ApiError || e instanceof CallsUnsupportedError
          ? e.message
          : 'Calls could not start in this browser. Try again in a minute.',
      );
      return false;
    }
  }, [freshToken, onIncoming, workspaceId]);

  // Whether calls work here: a token means yes. Browsers that turned calls on before start ringing again.
  const enableRef = useRef(enable);
  enableRef.current = enable;
  const applyCheck = useCallback(
    async (result: TokenCheck) => {
      if ('token' in result) {
        tokenRef.current = result.token;
        setCallerId(result.token.callerId);
        setProblem(null);
        if (remembered(workspaceId)) await enableRef.current();
        else setReadiness('off');
        return;
      }
      setProblem(result.problem);
      setReadiness(result.problem ? 'error' : 'unavailable');
    },
    [workspaceId],
  );
  useEffect(() => {
    if (deviceRef.current) return;
    let cancelled = false;
    void checkCalls(workspaceId).then((result) => (cancelled ? undefined : applyCheck(result)));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, numbers, applyCheck]);

  const retry = useCallback(async () => {
    const result = await checkCalls(workspaceId);
    await applyCheck(result);
    if ('problem' in result && result.problem) toast.error(result.problem);
  }, [applyCheck, workspaceId]);

  useEffect(
    () => () => {
      callRef.current?.disconnect();
      deviceRef.current?.destroy();
      deviceRef.current = null;
    },
    [],
  );

  // Toasts move up above the call bar while a call is on (globals.css).
  useEffect(() => {
    document.body.dataset.call = view.phase === 'idle' ? 'off' : 'on';
  }, [view.phase]);

  const answer = useCallback(() => {
    const v = viewRef.current;
    const call = callRef.current;
    if (v.phase !== 'incoming' || !call) return;
    call.accept();
    setView({
      phase: 'active',
      party: v.party,
      direction: 'inbound',
      startedAt: null,
      muted: false,
    });
  }, [setView]);

  const decline = useCallback(() => {
    const v = viewRef.current;
    const call = callRef.current;
    if (v.phase !== 'incoming' || !call) return;
    call.ignore();
    callRef.current = null;
    setView(IDLE);
    const others = alsoRingingText(v.info);
    toast(
      others
        ? `Declined here. It still rings ${others}, then goes to voicemail.`
        : 'Declined here. The caller goes to voicemail.',
    );
  }, [setView]);

  const hangUp = useCallback(() => {
    const call = callRef.current;
    if (call) call.disconnect();
    // Still connecting: placeCall drops the call once it exists.
    else if (viewRef.current.phase === 'calling') setView(IDLE);
  }, [setView]);

  const toggleMute = useCallback(() => {
    const v = viewRef.current;
    const call = callRef.current;
    if (v.phase !== 'active' || !call) return;
    call.mute(!v.muted);
    setView({ ...v, muted: !v.muted });
  }, [setView]);

  const sendDigit = useCallback((digit: string) => callRef.current?.sendDigits(digit), []);

  const placeCall = useCallback(
    async (target: CallTarget) => {
      if (viewRef.current.phase !== 'idle') {
        toast.error('Finish the call you’re on first.');
        return;
      }
      if (!(await enable())) return;
      const device = deviceRef.current;
      if (!device) return;
      const party: CallParty = {
        name: target.name,
        firstName: firstNameOf(target.name),
        phone: target.phone,
        personId: target.personId ?? null,
      };
      setView({ phase: 'calling', party, direction: 'outbound', startedAt: null, muted: false });
      try {
        const started = unwrap(
          await apiBrowser().POST('/v1/commands/call.start', {
            body: target.conversationId
              ? { workspaceId, conversationId: target.conversationId }
              : { workspaceId, personId: target.personId ?? undefined },
          }),
        );
        const call = await device.connect({ params: started.params });
        // Hung up while it was connecting (read the ref again: the await let other events in).
        if ((viewRef.current as CallView).phase !== 'calling') {
          call.disconnect();
          return;
        }
        callRef.current = call;
        call.on('accept', () =>
          setView((v) =>
            v.phase === 'calling' ? { ...v, phase: 'active', startedAt: Date.now() } : v,
          ),
        );
        call.on('disconnect', () => finish(call));
        call.on('cancel', () => finish(call));
        call.on('reject', () => finish(call));
        call.on('error', (err) => fail(call, err));
      } catch (e) {
        setView(IDLE);
        if (MIC_CODES.has(codeOf(e))) {
          setReadiness('blocked');
          toast.error(MIC_BLOCKED);
        } else toast.error(errorMessage(e));
      }
    },
    [enable, fail, finish, setView, workspaceId],
  );

  const value = useMemo<CallsValue>(
    () => ({
      workspaceId,
      workspaceName,
      readiness,
      problem,
      available: readiness !== 'checking' && readiness !== 'unavailable',
      callerId,
      view,
      dialer,
      enable,
      retry,
      openDialer: setDialer,
      closeDialer: () => setDialer(null),
      placeCall,
      answer,
      decline,
      hangUp,
      toggleMute,
      sendDigit,
    }),
    [
      workspaceId,
      workspaceName,
      readiness,
      problem,
      callerId,
      view,
      dialer,
      enable,
      retry,
      placeCall,
      answer,
      decline,
      hangUp,
      toggleMute,
      sendDigit,
    ],
  );
  return <CallsContext.Provider value={value}>{children}</CallsContext.Provider>;
}
