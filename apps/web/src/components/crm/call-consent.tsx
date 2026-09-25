'use client';
/**
 * AI outbound calls: whether a customer agreed in writing to calls from the business, on their Details. Campaign
 * calls go only to people who did, so saying yes needs where it's written. "Doesn't want calls" stops every AI
 * call to them (the AI records that itself when someone asks it on a call).
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';

type Consent = 'unknown' | 'opted_in' | 'opted_out';

const WORDS: Readonly<Record<Consent, string>> = {
  unknown: 'Not asked',
  opted_in: 'Agreed in writing',
  opted_out: 'Doesn’t want calls',
};

export function CallConsentRow({
  workspaceId,
  personId,
  consent,
  source,
  canEdit,
}: {
  workspaceId: string;
  personId: string;
  consent: Consent;
  source: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [next, setNext] = useState<'opted_in' | 'opted_out'>(
    consent === 'opted_out' ? 'opted_out' : 'opted_in',
  );
  const [where, setWhere] = useState(consent === 'opted_in' ? (source ?? '') : '');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/person.set_call_consent', {
          body: {
            workspaceId,
            personId,
            consent: next,
            ...(next === 'opted_in' ? { source: where.trim() } : {}),
          },
        }),
      );
      toast.success(
        next === 'opted_in'
          ? 'Saved. Campaign calls can go to them.'
          : 'Saved. The AI won’t call them.',
      );
      setEditing(false);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!editing)
    return (
      <span className="flex flex-wrap items-center gap-x-2" data-testid="call-consent">
        <span data-testid="call-consent-value">
          {WORDS[consent]}
          {consent === 'opted_in' && source ? ` (${source})` : ''}
        </span>
        {canEdit ? (
          <button
            type="button"
            className="text-[12.5px] font-medium text-accent-text hover:underline"
            onClick={() => setEditing(true)}
            data-testid="call-consent-edit"
          >
            Change
          </button>
        ) : null}
      </span>
    );
  return (
    <span className="flex flex-col gap-2" data-testid="call-consent-form">
      <Select
        selectSize="sm"
        aria-label="Calls from us"
        value={next}
        onChange={(e) => setNext(e.target.value as 'opted_in' | 'opted_out')}
        data-testid="call-consent-choice"
      >
        <option value="opted_in">Agreed in writing</option>
        <option value="opted_out">Doesn’t want calls</option>
      </Select>
      {next === 'opted_in' ? (
        <Input
          inputSize="sm"
          aria-label="Where they agreed"
          placeholder="Where they agreed: signed service agreement"
          value={where}
          maxLength={120}
          onChange={(e) => setWhere(e.target.value)}
          data-testid="call-consent-source"
        />
      ) : null}
      <span className="flex gap-2">
        <Button
          size="sm"
          onClick={() => void save()}
          loading={busy}
          disabled={next === 'opted_in' && !where.trim()}
          data-testid="call-consent-save"
        >
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
          Cancel
        </Button>
      </span>
    </span>
  );
}
