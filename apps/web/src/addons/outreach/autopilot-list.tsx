'use client';
/**
 * Autopilot's day's list, first on Needs you (docs/outreach.md, decisions 151 and 160;
 * packages/core/src/addons/outreach/autopilot.ts): the people it plans to reach today whom the person hasn't OK'd yet,
 * grouped by network, the spares last under "If you take anyone off, these go instead". Each name opens the person
 * menu (./person-menu.tsx), for Don't pitch or Never contact; each row has **Not today** (or **Put back**); and one
 * button OKs everyone still waiting. It shows only while someone waits for the OK (`autopilotListShown`): nothing
 * before the day's list is made, with nobody on it, once everyone's answered, or while Autopilot is off.
 */
import { AUTOPILOT_WORDS as A, autopilotListShown } from '@hfos/core/addons/outreach/autopilot';
import { PLATFORM_KEYS } from '@hfos/core/addons/outreach/networks';
import { TODAY_KINDS } from '@hfos/core/addons/outreach/today';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { CheckCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { NetworkName } from './network-ui';
import { PersonName } from './person-menu';
import type { Autopilot } from './types';
import { useAct } from './use-act';

type Person = Autopilot['people'][number];

export function AutopilotList({
  workspaceId,
  autopilot,
}: {
  workspaceId: string;
  autopilot: Autopilot | null;
}) {
  const { busy, act } = useAct();
  if (!autopilotListShown(autopilot)) return null;
  const answer = (
    key: string,
    body: { answer: 'ok' | 'not_today' | 'waiting'; profileIds?: string[] },
  ) =>
    act(key, async () => {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/outreach.autopilot.answer', {
          body: { workspaceId, ...body },
        }),
      );
      if (body.answer === 'ok' && !body.profileIds) toast.success(A.okdCount(out.changed));
    });
  const waiting = autopilot.people.filter((p) => p.state === 'waiting');
  const takenOff = autopilot.people.some((p) => p.state === 'not_today' || p.neverContact);
  const main = autopilot.people.filter((p) => !p.spare);
  const spares = autopilot.people.filter((p) => p.spare);
  return (
    <Card className="p-0" data-testid="outreach-autopilot-list">
      <div className="flex flex-wrap items-baseline justify-between gap-3 px-5 pt-4">
        <h3 className="text-[15px] font-semibold">
          {A.listTitle} <span className="text-text-3">· {waiting.length.toLocaleString()}</span>
        </h3>
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() => void answer('ok-all', { answer: 'ok' })}
          data-testid="autopilot-ok-all"
        >
          <CheckCheck className="h-3.5 w-3.5" strokeWidth={1.5} />
          {takenOff ? A.okRest(waiting.length) : A.okAll(waiting.length)}
        </Button>
      </div>
      <p className="px-5 pt-1.5 text-[12.5px] text-text-2">{A.listAbout}</p>
      <div className="mt-3 pb-2">
        <Rows workspaceId={workspaceId} people={main} busy={busy} answer={answer} />
        {spares.length ? (
          <>
            <p
              className="border-t border-border px-5 pb-1 pt-3 text-[12.5px] font-medium text-text-3"
              data-testid="autopilot-spares"
            >
              {A.spares}
            </p>
            <Rows workspaceId={workspaceId} people={spares} busy={busy} answer={answer} />
          </>
        ) : null}
      </div>
    </Card>
  );
}

/** One network's people at a time, in the networks' own order. */
function Rows({
  workspaceId,
  people,
  busy,
  answer,
}: {
  workspaceId: string;
  people: readonly Person[];
  busy: string | null;
  answer: (
    key: string,
    body: { answer: 'ok' | 'not_today' | 'waiting'; profileIds?: string[] },
  ) => Promise<boolean>;
}) {
  return (
    <>
      {PLATFORM_KEYS.map((platform) => {
        const on = people.filter((p) => p.platform === platform);
        if (!on.length) return null;
        return (
          <div key={platform} className="px-5 py-1.5" data-testid={`autopilot-${platform}`}>
            <NetworkName platform={platform} />
            <ul className="mt-1 divide-y divide-border">
              {on.map((p) => (
                <li
                  key={p.profileId}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2.5"
                  data-testid="autopilot-person"
                  data-state={p.state}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-[14px] font-medium">
                      <PersonName
                        workspaceId={workspaceId}
                        who={{
                          profileId: p.profileId,
                          name: p.name,
                          platform: p.platform,
                          url: p.url,
                          personId: p.personId,
                        }}
                        disabled={busy !== null}
                      />
                      {p.neverContact ? (
                        <Badge variant="danger">{W.person.neverContact}</Badge>
                      ) : p.dontPitch ? (
                        <Badge variant="pending">{W.person.dontPitch}</Badge>
                      ) : null}
                    </div>
                    <p className="text-[12.5px] text-text-2">
                      {[TODAY_KINDS[p.kind], ...p.why].join(' · ')}
                    </p>
                  </div>
                  {p.state === 'waiting' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={() =>
                        void answer(`off:${p.profileId}`, {
                          answer: 'not_today',
                          profileIds: [p.profileId],
                        })
                      }
                      data-testid="autopilot-not-today"
                    >
                      {A.notToday}
                    </Button>
                  ) : p.state === 'not_today' ? (
                    <div className="flex items-center gap-2">
                      <span className="text-[12.5px] text-text-3">{A.notToday}</span>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy !== null}
                        onClick={() =>
                          void answer(`back:${p.profileId}`, {
                            answer: 'waiting',
                            profileIds: [p.profileId],
                          })
                        }
                        data-testid="autopilot-put-back"
                      >
                        {A.putBack}
                      </Button>
                    </div>
                  ) : (
                    <span className="text-[12.5px] text-success-text">{A.okdLine}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </>
  );
}
