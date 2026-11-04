'use client';
import { Clapperboard, Copy, Play } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { copyText } from '@/components/ui/copy-field';
import { RadioCard } from '@/components/ui/radio-card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { SCENE_KIND_LABEL } from '@/lib/demo/scenes/types';

/** A business the scenes can play in. */
export interface DemoPlace {
  readonly workspaceId: string;
  readonly name: string;
  /** Bright Path: the founder opens it as its owner first (platform.view_as.start). */
  readonly asOwner: boolean;
}

export interface DemoSceneSummary {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly kind: keyof typeof SCENE_KIND_LABEL;
  readonly steps: readonly { readonly label: string; readonly voiceover: string }[];
  /** Its voiceover as one script, to copy. */
  readonly script: string;
}

/**
 * Admin → Demo player. Pick where the scenes play, then open the player there, or play one scene straight away. The
 * voiceover under each scene is the same the player's side menu shows, to read through before recording.
 */
export function DemoStart({
  places,
  founder,
  demoFound,
  demoName,
  scenes,
}: {
  places: readonly DemoPlace[];
  founder: boolean;
  demoFound: boolean;
  demoName: string;
  scenes: readonly DemoSceneSummary[];
}) {
  const [picked, setPicked] = useState(places[0]?.workspaceId ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const place = places.find((p) => p.workspaceId === picked) ?? null;

  /** Opens the player in the picked business: on its scene list, or playing `scene`. */
  const start = async (scene?: string) => {
    if (!place || busy) return;
    setBusy(scene ?? 'player');
    setError(null);
    try {
      if (place.asOwner)
        unwrap(
          await apiBrowser().POST('/v1/commands/platform.view_as.start', {
            body: { workspaceId: place.workspaceId },
          }),
        );
      // A whole page load, not a move inside the app: the scene is kept in a cookie for the business's pages only,
      // and a page first loaded here, in Admin, didn't see that cookie once it moved into the business.
      window.location.assign(`/app/w/${place.workspaceId}?demo${scene ? `=${scene}` : ''}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(null);
    }
  };

  const everything = scenes.map((s) => s.script).join('\n\n\n');

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6" data-testid="demo-admin">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-xl font-semibold md:text-2xl">Demo player</h1>
        <p className="max-w-2xl text-[14px] leading-relaxed text-text-2">
          Scripted scenes that play on the real app, one step each time you press Space, for videos
          and live shows. A scene’s people, messages and money are made up, and nothing in it is
          sent or saved.
        </p>
        <p className="max-w-2xl text-[13px] text-text-3" data-testid="demo-phone-scenes">
          Scenes 54 and 55 are about the phone’s notifications, so they play on the phone: open
          Admin → Demo player in the HandsFreeOS app.
        </p>
      </div>

      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-[15px] font-semibold">Where it plays</h2>
          {!founder ? (
            <p className="text-[13px] text-text-2">
              Only the founder can open {demoName} as its owner. You can play the scenes in a
              business of your own.
            </p>
          ) : !demoFound ? (
            <p className="text-[13px] text-text-2" data-testid="demo-business-missing">
              {demoName} isn’t on HandsFreeOS yet: it’s made by the app-store reviewers’ demo seed.
              Play the scenes in a business of your own for now.
            </p>
          ) : null}
        </div>
        {places.length ? (
          <div role="radiogroup" aria-label="Where it plays" className="flex flex-col gap-2">
            {places.map((p) => (
              <RadioCard
                key={p.workspaceId}
                selected={p.workspaceId === picked}
                onSelect={() => setPicked(p.workspaceId)}
                testId={`demo-place-${p.workspaceId}`}
                title={p.name}
                description={
                  p.asOwner
                    ? 'The demo business, with customers, jobs and invoices already in it. It opens as its owner, so stay inside the scenes: anything else you change there is real.'
                    : 'One of your businesses. The scenes’ people show beside its own.'
                }
              />
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-text-2">
            You’re not in a business yet. Make one from the app, then come back here to play the
            scenes in it.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => void start()}
            disabled={!place || (!!busy && busy !== 'player')}
            loading={busy === 'player'}
            data-testid="demo-open"
          >
            <Clapperboard className="h-4 w-4" strokeWidth={1.75} />
            Open the demo player
          </Button>
          <span className="text-[12.5px] text-text-3">
            Space or → plays the next step · ← goes back · R restarts · H hides the side menu
          </span>
        </div>
        {error ? (
          <p
            className="rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger-text"
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </Card>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-semibold">Scenes and their voiceover</h2>
          <button
            type="button"
            onClick={() => void copyText(everything, 'Copied every scene’s voiceover')}
            className="inline-flex items-center gap-1 text-[13px] font-medium text-accent-text hover:underline"
            data-testid="demo-copy-all"
          >
            <Copy className="h-3.5 w-3.5" />
            Copy every voiceover
          </button>
        </div>
        <ol className="flex flex-col gap-2.5">
          {scenes.map((s) => (
            <li key={s.id}>
              <Card className="flex flex-col gap-3 p-4" data-testid={`demo-admin-scene-${s.id}`}>
                <div className="flex flex-wrap items-start gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-text-3">
                      Scene {s.number} · {SCENE_KIND_LABEL[s.kind]}
                    </span>
                    <span className="text-[15px] font-semibold leading-snug">{s.title}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void copyText(s.script, 'Copied the voiceover')}
                      aria-label={`Copy scene ${s.number}’s voiceover`}
                      title="Copy the voiceover"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void start(s.id)}
                      disabled={!place || (!!busy && busy !== s.id)}
                      loading={busy === s.id}
                      data-testid={`demo-play-${s.id}`}
                    >
                      <Play className="h-3.5 w-3.5" />
                      Play
                    </Button>
                  </div>
                </div>
                <details className="group">
                  <summary className="cursor-pointer text-[13px] font-medium text-text-2 hover:text-text">
                    Voiceover · {s.steps.length} steps
                  </summary>
                  <ol className="mt-2.5 flex flex-col gap-2.5">
                    {s.steps.map((step, i) => (
                      <li key={i} className="flex gap-2.5">
                        <span className="mt-px inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-card-2 text-[11px] font-semibold text-text-3">
                          {i + 1}
                        </span>
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-[13px] font-medium leading-snug">{step.label}</span>
                          <span className="text-[13px] leading-relaxed text-text-2">
                            “{step.voiceover}”
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                </details>
              </Card>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
