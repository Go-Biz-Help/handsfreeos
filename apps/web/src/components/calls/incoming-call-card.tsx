'use client';
import { formatPhone } from '@hfos/core';
import { Phone, PhoneIncoming } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { alsoRingingText, useCalls } from '@/lib/calls/call-provider';

/**
 * A customer is calling: who, what else rings, Answer or Decline. It sits above everything (dialogs
 * included) without taking focus, so typing in the composer never answers by accident.
 */
export function IncomingCallCard() {
  const calls = useCalls();
  const view = calls.view;
  if (view.phase !== 'incoming') return null;
  const { party, info } = view;
  const others = alsoRingingText(info);
  const detail = [party.phone ? formatPhone(party.phone) : '', info.leadTitle]
    .filter(Boolean)
    .join(' · ');
  return createPortal(
    <div
      role="alertdialog"
      aria-label="Incoming call"
      aria-describedby="incoming-call-who"
      data-testid="incoming-call"
      style={{ pointerEvents: 'auto' }}
      className="fixed inset-x-4 top-4 z-[70] flex flex-col gap-3.5 rounded-dialog border border-border bg-card p-4 shadow-3 md:inset-x-auto md:right-[18px] md:top-[18px] md:w-[360px]"
    >
      <div className="flex items-center gap-3">
        <span className="call-ring relative flex h-11 w-11 flex-none items-center justify-center rounded-full bg-success-soft text-success-text">
          <PhoneIncoming className="h-[18px] w-[18px]" strokeWidth={1.5} />
        </span>
        <div className="min-w-0 flex-1" id="incoming-call-who">
          <div className="truncate text-xs text-text-3">Incoming call · {info.lineName}</div>
          <h3 className="truncate text-[15px] font-semibold">{party.name}</h3>
          <div className="truncate text-[13px] text-text-2">
            {party.personId ? detail : `${detail ? `${detail} · ` : ''}Not in Contacts yet`}
          </div>
        </div>
      </div>
      {others ? (
        <p className="text-xs text-text-3">Also ringing {others}. The first to answer takes it.</p>
      ) : null}
      <div className="flex gap-2">
        <Button
          variant="danger"
          className="flex-1 text-on-solid"
          onClick={calls.decline}
          data-testid="call-decline"
        >
          <Phone className="h-3.5 w-3.5 rotate-[135deg]" strokeWidth={1.75} />
          Decline
        </Button>
        <Button
          variant="success"
          className="flex-1"
          onClick={calls.answer}
          data-testid="call-answer"
        >
          <Phone className="h-3.5 w-3.5" strokeWidth={1.75} />
          Answer
        </Button>
      </div>
    </div>,
    document.body,
  );
}
