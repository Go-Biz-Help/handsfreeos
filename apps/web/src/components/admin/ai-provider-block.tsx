'use client';
import {
  DESK_AI_MODE_WORDS,
  DESK_AI_MODES,
  DESK_AI_WORDS,
  deskAiFacts,
  deskAiOverruled,
  deskAiWhy,
} from '@hfos/core';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { whenWords } from '@/components/admin/ticket-bits';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';
import { cn } from '@/lib/utils';

type AiProvider = Ok<'/v1/queries/platform.ai_provider.get'>;
type Mode = AiProvider['mode'];

/**
 * Which AI answers every business: Claude, or OpenAI while Claude is in trouble. On Auto the worker moves it by
 * itself; support keeps it on one when the checks get it wrong. Every worker follows within half a minute.
 */
export function AiProviderBlock({ ai, canChange }: { ai: AiProvider | null; canChange: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (mode: Mode) => {
    if (!ai || mode === ai.mode || busy) return;
    setBusy(true);
    setError(null);
    try {
      unwrap(await apiBrowser().POST('/v1/commands/ai_provider.set_mode', { body: { mode } }));
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!ai)
    return (
      <section
        className="mt-6 rounded-card border border-border bg-card p-4"
        data-testid="admin-ai-provider"
      >
        <h2 className="text-sm font-semibold">{DESK_AI_WORDS.title}</h2>
        <p className="mt-2 text-[13px] text-text-3">
          Couldn’t read which AI is answering. Refresh the page in a minute.
        </p>
      </section>
    );

  // Why it's where it is: the checks' reason on Auto, or who kept it there.
  const why = deskAiWhy(ai, whenWords);
  // Kept on Claude while the checks would have moved it: worth saying, since that's the risky way round.
  const overruled = deskAiOverruled(ai);
  const facts = deskAiFacts(ai, whenWords);

  return (
    <section
      className="mt-6 rounded-card border border-border bg-card p-4"
      data-testid="admin-ai-provider"
    >
      <h2 className="text-sm font-semibold">{DESK_AI_WORDS.title}</h2>
      <dl className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        {facts.map((f) => (
          <div key={f.label}>
            <dt className="text-[13px] text-text-3">{f.label}</dt>
            <dd className={cn('mt-0.5 text-base font-semibold', f.warn && 'text-warning-text')}>
              {f.value}
            </dd>
          </div>
        ))}
      </dl>
      {why ? <p className="mt-3 text-[13px] text-text-2">{why}</p> : null}
      {overruled ? <p className="mt-1 text-[13px] text-warning-text">{overruled}</p> : null}
      <div className="mt-4">
        {canChange ? (
          <Segmented<Mode>
            ariaLabel={DESK_AI_WORDS.title}
            value={ai.mode}
            onChange={(v) => void pick(v)}
            options={DESK_AI_MODES.map((m) => ({
              value: m,
              label: DESK_AI_MODE_WORDS[m],
              testId: `admin-ai-provider-${m}`,
              disabled: busy,
            }))}
          />
        ) : (
          <p className="text-[13px] font-medium">{DESK_AI_MODE_WORDS[ai.mode]}</p>
        )}
        <p className="mt-2 text-[13px] text-text-3">{DESK_AI_WORDS.autoExplain}</p>
      </div>
      {error ? <p className="mt-2 text-[13px] text-danger-text">{error}</p> : null}
    </section>
  );
}
