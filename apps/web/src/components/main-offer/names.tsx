'use client';
import { cleanNames, MAIN_OFFER_LIMITS, MAIN_OFFER_NAMES_WORDS as W } from '@hfos/core';
import { Building2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { errorMessage } from '@/lib/api/errors';
import { saveOfferNames } from '@/lib/main-offer/actions';

/**
 * The names the business goes by on people's profiles (docs/outreach.md, decision 84), on Settings → Main offer:
 * its company and the brand it sells. Social Outreach's profile check looks for them; with none, it looks for the
 * business's name in HandsFreeOS, which the card says. Owners and admins change them; everyone sees them.
 */
export function OfferNames({
  workspaceId,
  names: saved,
  businessName,
  canManage,
}: {
  workspaceId: string;
  names: readonly string[];
  businessName: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [names, setNames] = useState<string[]>([...saved]);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const full = names.length >= MAIN_OFFER_LIMITS.names;

  /** Each change saves at once; one that can't be saved goes back, saying why. */
  async function save(next: string[]) {
    const before = names;
    setNames(next);
    setBusy(true);
    try {
      const { names: kept } = await saveOfferNames(workspaceId, next);
      setNames(kept);
      toast.success(W.saved);
      router.refresh();
    } catch (e) {
      setNames(before);
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const add = () => {
    void save(cleanNames([...names, typed]).slice(0, MAIN_OFFER_LIMITS.names));
    setTyped('');
  };

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="main-offer-names">
      <span className="flex items-center gap-2 font-semibold">
        <Building2 className="h-4 w-4 text-accent-text" strokeWidth={1.75} />
        {W.title}
      </span>
      <p className="text-[13px] text-text-2">{W.hint}</p>
      {names.length ? (
        <ul className="flex flex-wrap gap-2" aria-label={W.title}>
          {names.map((name) => (
            <li
              key={name}
              className="flex h-8 items-center gap-1 rounded-full border border-border-strong bg-card pl-3 pr-1 text-[13px] font-medium"
            >
              {name}
              {canManage ? (
                <button
                  type="button"
                  aria-label={W.remove(name)}
                  disabled={busy}
                  onClick={() => void save(names.filter((n) => n !== name))}
                  className="flex h-6 w-6 items-center justify-center rounded-full text-text-3 hover:bg-card-2 hover:text-text"
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-text-3" data-testid="main-offer-names-default">
          {W.usingDefault(businessName)}
        </p>
      )}
      {canManage ? (
        <div className="flex flex-col gap-2">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed.trim() && !full) add();
            }}
          >
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              maxLength={MAIN_OFFER_LIMITS.name}
              placeholder={W.placeholder}
              aria-label={W.label}
              disabled={full}
              className="min-w-0 flex-1"
              data-testid="main-offer-names-input"
            />
            <Button
              type="submit"
              variant="secondary"
              loading={busy}
              disabled={!typed.trim() || full}
              data-testid="main-offer-names-add"
            >
              {W.add}
            </Button>
          </form>
          {full ? <p className="text-xs text-text-3">{W.most(MAIN_OFFER_LIMITS.names)}</p> : null}
        </div>
      ) : null}
    </Card>
  );
}
