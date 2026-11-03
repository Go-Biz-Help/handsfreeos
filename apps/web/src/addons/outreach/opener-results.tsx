'use client';
/**
 * Which openers work (docs/outreach.md; on Results since decision 129, under the playbooks before): for each playbook,
 * its openers with what came of the first messages sent with them, who wrote back and who booked a demo
 * (`outreach.openers`), everyone's for owners and admins.
 */
import {
  bestOpenerOf,
  OPENER_KINDS,
  OPENER_RESULT_WORDS as O,
  openerShort,
  type OpenerResult,
} from '@hfos/core/addons/outreach/openers';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { Openers } from './types';

export function OpenerResults({ openers }: { openers: Openers }) {
  const shown = openers.playbooks.filter((p) => p.openers.length);
  if (!shown.length) return null;
  return (
    <Card className="p-5" data-testid="opener-results">
      <h3 className="text-[15px] font-semibold">{O.title}</h3>
      <p className="mt-0.5 text-[13px] text-text-2">{O.about(openers.everyone)}</p>
      <div className="mt-4 space-y-5">
        {shown.map((p) => {
          const best = bestOpenerOf(p.openers);
          return (
            <section key={p.playbookId}>
              <h4 className="text-[12.5px] font-semibold uppercase tracking-wide text-text-3">
                {p.name}
              </h4>
              <ul className="mt-1.5 divide-y divide-border">
                {p.openers.map((o) => (
                  <OpenerRow key={`${o.kind}:${o.text}`} opener={o} best={o === best} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </Card>
  );
}

function OpenerRow({ opener: o, best }: { opener: OpenerResult; best: boolean }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px]">{openerShort(o.text)}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-text-3">
          <span>{OPENER_KINDS[o.kind]}</span>
          {o.current ? null : <span>· {O.notNow}</span>}
          {best ? <Badge variant="accent">{O.best}</Badge> : null}
        </div>
      </div>
      <div className="text-right text-[12.5px] text-text-2">
        <div>{O.replies(o)}</div>
        {o.sent ? <div className="text-text-3">{O.demos(o.demos)}</div> : null}
      </div>
    </li>
  );
}
