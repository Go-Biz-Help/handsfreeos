'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { whenWords } from '@/components/admin/ticket-bits';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Ok } from '@/lib/api/types';
import { cn } from '@/lib/utils';

type AiProvider = Ok<'/v1/queries/platform.ai_provider.get'>;
type Mode = AiProvider['mode'];

const NAME: Readonly<Record<AiProvider['answering'], string>> = {
  claude: 'Claude',
  openai: 'OpenAI',
};

const MODE_WORDS: Readonly<Record<Mode, string>> = {
  auto: 'Auto',
  claude: 'Always Claude',
  openai: 'Always OpenAI',
};

/** Why the checks moved it to OpenAI. */
const REASON_WORDS: Readonly<Record<NonNullable<AiProvider['reason']>, string>> = {
  status: 'Claude’s status page reports trouble',
  errors: 'Claude’s answers kept failing',
};

/** What Claude's status page said about the Claude API, in plain words. */
const STATUS_WORDS: Readonly<Record<string, string>> = {
  operational: 'All good',
  degraded_performance: 'Slow',
  partial_outage: 'Partly down',
  major_outage: 'Down',
  under_maintenance: 'Maintenance',
};

const statusWords = (status: string | null) =>
  status === null ? 'Not checked yet' : (STATUS_WORDS[status] ?? status.replaceAll('_', ' '));

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
        <h2 className="text-sm font-semibold">Which AI answers</h2>
        <p className="mt-2 text-[13px] text-text-3">
          Couldn’t read which AI is answering. Refresh the page in a minute.
        </p>
      </section>
    );

  // Why it's where it is: the checks' reason on Auto, or who kept it there.
  const why =
    ai.mode === 'auto'
      ? ai.answering === 'openai' && ai.reason
        ? `${REASON_WORDS[ai.reason]}. Back on Claude after two good checks in a row (${Math.min(ai.goodChecks, 2)} so far).`
        : null
      : `Kept on ${NAME[ai.mode]}${ai.modeSetBy ? ` by ${ai.modeSetBy}` : ''}${ai.modeSetAt ? `, ${whenWords(ai.modeSetAt)}` : ''}.`;
  // Kept on Claude while the checks would have moved it: worth saying, since that's the risky way round.
  const overruled =
    ai.mode === 'claude' && ai.active === 'openai' && ai.reason
      ? `On Auto it would be on OpenAI now: ${REASON_WORDS[ai.reason]}.`
      : null;

  const facts = [
    {
      label: 'Answering now',
      value: NAME[ai.answering],
      tone: ai.answering === 'openai' ? 'text-warning-text' : '',
    },
    {
      label: 'Claude’s status page',
      value: statusWords(ai.claudeStatus),
      tone:
        ai.claudeStatus === null || ai.claudeStatus === 'operational' ? '' : 'text-warning-text',
    },
    { label: 'Last checked', value: ai.checkedAt ? whenWords(ai.checkedAt) : 'Not yet', tone: '' },
    {
      label: 'Last switched',
      value: ai.switchedAt ? whenWords(ai.switchedAt) : 'Never',
      tone: '',
    },
  ];

  return (
    <section
      className="mt-6 rounded-card border border-border bg-card p-4"
      data-testid="admin-ai-provider"
    >
      <h2 className="text-sm font-semibold">Which AI answers</h2>
      <dl className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        {facts.map((f) => (
          <div key={f.label}>
            <dt className="text-[13px] text-text-3">{f.label}</dt>
            <dd className={cn('mt-0.5 text-base font-semibold', f.tone)}>{f.value}</dd>
          </div>
        ))}
      </dl>
      {why ? <p className="mt-3 text-[13px] text-text-2">{why}</p> : null}
      {overruled ? <p className="mt-1 text-[13px] text-warning-text">{overruled}</p> : null}
      <div className="mt-4">
        {canChange ? (
          <Segmented<Mode>
            ariaLabel="Which AI answers"
            value={ai.mode}
            onChange={(v) => void pick(v)}
            options={(['auto', 'claude', 'openai'] as const).map((m) => ({
              value: m,
              label: MODE_WORDS[m],
              testId: `admin-ai-provider-${m}`,
              disabled: busy,
            }))}
          />
        ) : (
          <p className="text-[13px] font-medium">{MODE_WORDS[ai.mode]}</p>
        )}
        <p className="mt-2 text-[13px] text-text-3">
          Auto moves to OpenAI when Claude’s status page shows trouble or its answers fail, and back
          after two good checks 5 minutes apart.
        </p>
      </div>
      {error ? <p className="mt-2 text-[13px] text-danger-text">{error}</p> : null}
    </section>
  );
}
