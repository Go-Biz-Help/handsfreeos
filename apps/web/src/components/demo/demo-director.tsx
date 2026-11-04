'use client';
import { ChevronLeft, ChevronRight, Clapperboard, EyeOff, RotateCcw, X } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAssistant } from '@/components/assistant/assistant-provider';
import { Button } from '@/components/ui/button';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { installDemoFetch } from '@/lib/demo/browser';
import { DEMO_SCENES, findScene, type DemoPlayer, type DemoScene } from '@/lib/demo/scenes';
import { clearDemoState, readDemoState, writeDemoState, type DemoState } from '@/lib/demo/state';
import { emitLocalChange } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { clickOn, find, pointAt, removePointer, sleep, waitFor } from './pointer';

// Before any screen fetches, so a page reloaded mid-scene gets the scene's answers from its first request.
installDemoFetch();

const PANEL_PX = 300;
const onKey = (workspaceId: string) => `hfos-demo-panel:${workspaceId}`;
/** What the screens on show fetch again after Back, Restart or Exit. */
const EVERYTHING = [
  'conversation',
  'message',
  'ai_teammate_draft',
  'appointment',
  'activity',
  'campaign',
  'person',
];

/**
 * The demo player (staff only): pick a scene, then each press of Space (or →, or a presentation clicker) plays its
 * next step on the real screens, with a pointer that moves and clicks as a person would. The panel on the left lists
 * every step so the presenter knows what comes next, and is meant to be left out of what's shared; H hides it.
 * Opened with `?demo` on any page of the business, and kept open in this browser until Exit.
 */
export function DemoDirector({
  workspaceId,
  businessName,
  timeZone,
  me,
}: {
  workspaceId: string;
  businessName: string;
  timeZone: string;
  me: { id: string; name: string };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const assistant = useAssistant();
  const assistantRef = useRef(assistant);
  assistantRef.current = assistant;
  const [on, setOn] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [state, setState] = useState<DemoState | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const busyRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  // `?demo` opens it; this browser remembers until Exit; a scene left playing (a reload) opens it as well.
  useEffect(() => {
    const asked = new URLSearchParams(window.location.search).has('demo');
    let remembered = false;
    try {
      if (asked) localStorage.setItem(onKey(workspaceId), 'on');
      remembered = localStorage.getItem(onKey(workspaceId)) === 'on';
    } catch {
      // Private windows: it stays open for this page only.
    }
    const playing = readDemoState();
    setOn(asked || remembered || !!playing);
    if (playing) setState(playing);
  }, [pathname, workspaceId]);

  // The app moves right of the panel, so the panel can be left out of a shared window.
  useEffect(() => {
    if (!on || hidden) return;
    const before = document.body.style.paddingLeft;
    document.body.style.paddingLeft = `${PANEL_PX}px`;
    return () => {
      document.body.style.paddingLeft = before;
    };
  }, [on, hidden]);

  const scene = state ? findScene(state.scene) : null;
  const done = state?.steps.length ?? 0;

  const player = useMemo<DemoPlayer>(() => {
    const pageOf = (path: string) => `/app/w/${workspaceId}${path ? `/${path}` : ''}`;
    const until = async (ok: () => boolean, ms = 8000) => {
      const end = Date.now() + ms;
      while (!ok() && Date.now() < end) await sleep(100);
    };
    const openAssistant = async () => {
      const a = assistantRef.current;
      if (!a.open) {
        const button = find('@ask-assistant');
        if (button) await clickOn(button);
        else a.setOpen(true);
      } else {
        const button = find('@ask-assistant');
        if (button) await pointAt(button);
      }
      assistantRef.current.newChat();
      await waitFor('[data-testid="assistant-composer"] textarea');
    };
    return {
      workspaceId,
      async go(path) {
        const href = pageOf(path);
        if (window.location.pathname === href) return;
        const link = find(`aside a[href="${href}"]`);
        if (link) await clickOn(link);
        else router.push(href);
        await until(() => window.location.pathname === href);
        await sleep(300);
      },
      async click(target) {
        await clickOn(await waitFor(target));
      },
      async point(target) {
        await pointAt(await waitFor(target));
      },
      openAssistant,
      async ask(question) {
        if (!assistantRef.current.open) await openAssistant();
        const box = await waitFor('[data-testid="assistant-composer"] textarea');
        await pointAt(box);
        // Typed a letter at a time, at a person's pace.
        for (let i = 1; i <= question.length; i++) {
          assistantRef.current.setDraft(question.slice(0, i));
          await sleep(question[i - 1] === ' ' ? 55 : 28 + Math.random() * 30);
        }
        await sleep(350);
        await clickOn(await waitFor('@assistant-send'));
      },
      waitFor,
      wait: sleep,
    };
  }, [router, workspaceId]);

  /** Keys come back to the player after a step: a step that focused a box would otherwise take the next Space. */
  const settle = () => {
    const el = document.activeElement;
    if (el instanceof HTMLElement && el !== document.body) el.blur();
  };

  const next = useCallback(async () => {
    const s = stateRef.current;
    const sc = s ? findScene(s.scene) : null;
    if (!s || !sc || busyRef.current) return;
    const step = sc.steps[s.steps.length];
    if (!step) return;
    busyRef.current = true;
    setBusy(true);
    setProblem(null);
    // What the step makes up lands first, so whatever the run opens or refreshes already shows it.
    const moved: DemoState = { ...s, steps: [...s.steps, Date.now() - s.startedAt] };
    writeDemoState(workspaceId, moved);
    stateRef.current = moved;
    setState(moved);
    if (step.live?.length) emitLocalChange(step.live);
    try {
      await step.run?.(player);
    } catch (e) {
      setProblem(
        `${e instanceof Error ? e.message : 'That step didn’t finish.'} Press Next to carry on, or Back to try it again.`,
      );
    } finally {
      settle();
      busyRef.current = false;
      setBusy(false);
    }
  }, [player, workspaceId]);

  const back = useCallback(() => {
    const s = stateRef.current;
    if (!s || !s.steps.length || busyRef.current) return;
    const moved: DemoState = { ...s, steps: s.steps.slice(0, -1) };
    writeDemoState(workspaceId, moved);
    stateRef.current = moved;
    setState(moved);
    setProblem(null);
    emitLocalChange(EVERYTHING);
    router.refresh();
  }, [router, workspaceId]);

  const load = useCallback(
    async (sc: DemoScene) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        // Made-up messages sign off with the business's own teammate's name.
        const got = await apiBrowser()
          .POST('/v1/queries/ai_teammate.get', { body: { workspaceId } })
          .then(unwrap)
          .catch(() => null);
        const fresh: DemoState = {
          scene: sc.id,
          steps: [],
          startedAt: Date.now(),
          business: businessName,
          teammate: got?.teammate?.name ?? 'Ava',
          timeZone,
          me,
        };
        writeDemoState(workspaceId, fresh);
        stateRef.current = fresh;
        setState(fresh);
        setProblem(null);
        const a = assistantRef.current;
        a.newChat();
        a.setOpen(false);
        removePointer();
        const href = `/app/w/${workspaceId}${sc.startsOn ? `/${sc.startsOn}` : ''}`;
        if (window.location.pathname !== href) router.push(href);
        else router.refresh();
        emitLocalChange(EVERYTHING);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [businessName, me, router, timeZone, workspaceId],
  );

  const restart = useCallback(() => {
    const sc = stateRef.current ? findScene(stateRef.current.scene) : null;
    if (sc) void load(sc);
  }, [load]);

  const exit = useCallback(() => {
    clearDemoState(workspaceId);
    try {
      localStorage.removeItem(onKey(workspaceId));
    } catch {
      // Nothing was remembered.
    }
    stateRef.current = null;
    setState(null);
    setOn(false);
    setProblem(null);
    assistantRef.current.newChat();
    removePointer();
    emitLocalChange(EVERYTHING);
    router.refresh();
  }, [router, workspaceId]);

  // Space, → or Page Down (what presentation clickers send) plays the next step; ← goes back; R restarts; H hides.
  useEffect(() => {
    if (!on) return;
    const handle = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      // Ask HandsFreeOS puts the cursor in its box when it opens; while a scene plays, the keys are still the player's.
      const composer = !!t?.closest('[data-testid="assistant-composer"]') && !!stateRef.current;
      if (
        !composer &&
        t &&
        (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))
      )
        return;
      let handled = true;
      switch (e.key) {
        case ' ':
        case 'ArrowRight':
        case 'PageDown':
          void next();
          break;
        case 'ArrowLeft':
        case 'PageUp':
          back();
          break;
        case 'r':
        case 'R':
          if (composer) handled = false;
          else restart();
          break;
        case 'h':
        case 'H':
          if (composer) handled = false;
          else setHidden((h) => !h);
          break;
        default:
          handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', handle, true);
    return () => window.removeEventListener('keydown', handle, true);
  }, [on, next, back, restart]);

  if (!on || hidden) return null;
  return (
    <aside
      className="fixed inset-y-0 left-0 z-[60] flex flex-col border-r border-border bg-card text-text shadow-3 print:hidden"
      style={{ width: PANEL_PX }}
      aria-label="Demo player"
      data-testid="demo-director"
    >
      <div className="flex flex-none items-center gap-2 border-b border-border px-4 py-3">
        <Clapperboard className="h-4 w-4 text-accent-text" strokeWidth={1.75} />
        <span className="flex-1 text-[13.5px] font-semibold">Demo player</span>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => setHidden(true)}
          aria-label="Hide the panel (H)"
          title="Hide the panel (H)"
        >
          <EyeOff className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={exit}
          aria-label="Exit the demo"
          title="Exit the demo"
          data-testid="demo-exit"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {scene ? (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-text-3">
                Scene {scene.number} ·{' '}
                {scene.kind === 'assistant' ? 'Ask HandsFreeOS' : 'AI teammate'}
              </span>
              <span className="text-[15px] font-semibold leading-snug">{scene.title}</span>
            </div>
            <ol className="flex flex-col gap-1" data-testid="demo-steps">
              {scene.steps.map((step, i) => {
                const isNext = i === done;
                const ran = i < done;
                return (
                  <li
                    key={i}
                    className={cn(
                      'flex gap-2.5 rounded-control px-2 py-2',
                      isNext && 'bg-accent-soft',
                    )}
                    data-testid={isNext ? 'demo-next-step' : undefined}
                    aria-current={isNext ? 'step' : undefined}
                  >
                    <span
                      className={cn(
                        'mt-px inline-flex h-5 w-5 flex-none items-center justify-center rounded-full text-[11px] font-semibold',
                        ran
                          ? 'bg-success text-white'
                          : isNext
                            ? 'bg-accent text-white'
                            : 'bg-card-2 text-text-3',
                      )}
                    >
                      {ran ? '✓' : i + 1}
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span
                        className={cn(
                          'text-[13px] leading-snug',
                          ran ? 'text-text-3' : isNext ? 'font-semibold' : 'text-text-2',
                        )}
                      >
                        {step.label}
                      </span>
                      {isNext && step.say ? (
                        <span className="text-[12px] leading-snug text-text-2">“{step.say}”</span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
              {done >= scene.steps.length ? (
                <li className="px-2 py-2 text-[13px] text-text-2" data-testid="demo-scene-done">
                  That’s the end of this scene. Pick another below, or press R to play it again.
                </li>
              ) : null}
            </ol>
            {problem ? (
              <p
                className="rounded-control bg-danger-soft px-3 py-2 text-[12.5px] text-danger-text"
                role="alert"
              >
                {problem}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-[13px] leading-snug text-text-2">
            Pick a scene. Each press of Space plays its next step on the real screens. Nothing is
            sent or saved: the people and messages in a scene are made up.
          </p>
        )}

        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-text-3">
            Scenes
          </span>
          {DEMO_SCENES.map((sc) => (
            <button
              key={sc.id}
              type="button"
              onClick={() => void load(sc)}
              disabled={busy}
              className={cn(
                'flex items-start gap-2 rounded-control px-2 py-1.5 text-left text-[13px] leading-snug hover:bg-card-2',
                sc.id === scene?.id && 'font-semibold',
              )}
              data-testid={`demo-scene-${sc.id}`}
            >
              <span className="w-4 flex-none text-text-3">{sc.number}</span>
              <span>{sc.title}</span>
            </button>
          ))}
        </div>
      </div>

      {scene ? (
        <div className="flex flex-none flex-col gap-2 border-t border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={back}
              disabled={busy || done === 0}
              aria-label="Back (←)"
              title="Back (←)"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={restart}
              disabled={busy}
              aria-label="Restart (R)"
              title="Restart (R)"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              className="flex-1"
              onClick={() => void next()}
              loading={busy}
              disabled={done >= scene.steps.length}
              data-testid="demo-next"
            >
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-[11.5px] leading-snug text-text-3">
            Space or → plays the next step · ← goes back · R restarts · H hides this panel
          </p>
        </div>
      ) : null}
    </aside>
  );
}
