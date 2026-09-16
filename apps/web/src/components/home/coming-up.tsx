'use client';
import { clockLabel } from '@hfos/core';
import { CalendarCheck, MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { BrandMark } from '@/components/ui/brand';
import { Card } from '@/components/ui/card';
import type { AttentionScheduled } from '@/lib/api/types';
import { FoldButton } from './attention-bits';
import { useAttentionEnv } from './attention-context';
import { splitTitle } from './attention-words';

const FOOT = 'border-t border-border bg-card-2 px-4 py-[9px] text-xs text-text-3';
const WAITS = 'Each one waits 60 minutes so you can cancel.';

const willDo = (s: AttentionScheduled, at: string) =>
  s.action === 'confirm_request' ? `Will ask to confirm at ${at}` : `Will follow up at ${at}`;

function Rows({ scheduled }: { scheduled: readonly AttentionScheduled[] }) {
  const env = useAttentionEnv();
  if (!scheduled.length)
    return (
      <p className="border-t border-border px-4 py-2.5 text-[13px] text-text-3">
        Nothing planned right now.
      </p>
    );
  return (
    <ul>
      {scheduled.map((s) => {
        const { head, rest } = splitTitle(s.title);
        const Icon = s.action === 'confirm_request' ? CalendarCheck : MessageCircle;
        return (
          <li
            key={s.itemId}
            data-testid="coming-up-row"
            data-item={s.itemId}
            className="flex items-start gap-2.5 border-t border-border px-4 py-2.5"
          >
            <span
              aria-hidden
              className="mt-px inline-flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[7px] bg-accent-soft text-accent-text"
            >
              <Icon className="h-[13px] w-[13px]" strokeWidth={1.75} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="truncate text-[13px]">
                <span className="font-medium">{head}</span>
                {rest ? <span className="text-text-3"> · {rest}</span> : null}
              </span>
              <span className="text-[13px] text-text-2">
                {willDo(s, clockLabel(Date.parse(s.scheduledFor), env.timeZone))} ·{' '}
                <button
                  type="button"
                  data-testid="coming-up-cancel"
                  disabled={env.busy.has(s.itemId)}
                  onClick={() =>
                    env.act.cancelAuto({ itemId: s.itemId, name: head, action: s.action })
                  }
                  className="font-medium text-accent-text hover:underline disabled:opacity-50"
                >
                  Cancel
                </button>
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** "Coming up from HandsFreeOS": confirmation requests and follow-ups waiting out their cancel window. */
export function ComingUp({ scheduled }: { scheduled: readonly AttentionScheduled[] }) {
  return (
    <Card className="overflow-hidden" data-testid="coming-up">
      <div className="flex items-center gap-2 px-4 pb-[9px] pt-[13px]">
        <BrandMark size={20} />
        <h3 className="flex-1 text-[15px] font-semibold">Coming up from HandsFreeOS</h3>
      </div>
      <Rows scheduled={scheduled} />
      <div className={FOOT}>{WAITS}</div>
    </Card>
  );
}

/** The same, folded below the list on a phone. */
export function ComingUpFold({ scheduled }: { scheduled: readonly AttentionScheduled[] }) {
  const env = useAttentionEnv();
  const [open, setOpen] = useState(false);
  const first = scheduled[0];
  const sub = first
    ? `${
        first.action === 'confirm_request'
          ? `Will ask ${splitTitle(first.title).head} to confirm`
          : `Will follow up with ${splitTitle(first.title).head}`
      } at ${clockLabel(Date.parse(first.scheduledFor), env.timeZone)}${
        scheduled.length > 1 ? ` · ${scheduled.length - 1} more` : ''
      }`
    : 'Nothing planned right now';
  return (
    <div data-testid="coming-up-fold">
      <FoldButton
        open={open}
        onToggle={() => setOpen(!open)}
        icon={<BrandMark size={20} />}
        title="Coming up from HandsFreeOS"
        sub={sub}
        badge={<Badge variant="gray">{scheduled.length}</Badge>}
      />
      {open ? (
        <div className="overflow-hidden rounded-b-card border border-t-0 border-border-strong bg-card">
          <Rows scheduled={scheduled} />
          <div className={FOOT}>{WAITS}</div>
        </div>
      ) : null}
    </div>
  );
}
