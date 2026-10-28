'use client';
/**
 * Social Outreach's panel on a customer's page: each profile the extension saved for them, with how they came along
 * (decision 103): where they stand and why, the AI's next step, the groups they were found in, the chat's summary and
 * every step either way, the latest first; and the chats saved with them, newest messages last. Drawn by <AddonSlot>
 * only while the add-on runs and for people with `outreach.use`; a customer nobody saved from a network shows nothing.
 * Once their demo is done, their lead waits for the person's won or lost here (decision 106). Who reached them first
 * shows too (decision 107).
 */
import { journeyStepWords } from '@hfos/core/addons/outreach/journey';
import {
  DEMO_LOST_WHY_MOST,
  DEMO_OUTCOME_WORDS as D,
  type DemoOutcome,
  leadWords,
} from '@hfos/core/addons/outreach/leads';
import { OWNER_WORDS } from '@hfos/core/addons/outreach/owners';
import { PLATFORMS, type Platform } from '@hfos/core/addons/outreach/playbooks';
import { STAGES } from '@hfos/core/addons/outreach/stages';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { Handshake } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn, relativeTime } from '@/lib/utils';
import type { SlotProps } from '../registry';
import { outreachHref } from './address';
import { STAGE_TONE } from './pipeline-view';
import type { PersonSocial } from './types';
import { useAct } from './use-act';

const FRIENDSHIP: Record<string, string | null> = {
  friends: 'Friends',
  request_sent: 'Friend request sent',
  request_received: 'They sent a friend request',
  not_friends: 'Not friends',
  unknown: null,
};

/** A chat shows this many of its latest messages until it's opened up. */
const LATEST = 4;
/** And a profile this many of its latest steps. */
const LATEST_STEPS = 5;

type Profile = PersonSocial['profiles'][number];

export default function PersonPanel({ workspaceId, personId }: SlotProps<'person.panels'>) {
  const [social, setSocial] = useState<PersonSocial | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let live = true;
    void apiBrowser()
      .POST('/v1/queries/outreach.person', { body: { workspaceId, personId } })
      .then(unwrap)
      .then((s) => live && setSocial(s))
      .catch(() => live && setSocial({ profiles: [], chats: [] }));
    return () => {
      live = false;
    };
  }, [workspaceId, personId, version]);

  if (!social || (social.profiles.length === 0 && social.chats.length === 0)) return null;
  return (
    <Card className="p-4 md:p-5" data-testid="outreach-panel">
      <h3 className="mb-2.5 flex items-center gap-2 text-[15px] font-semibold">
        <Handshake className="h-4 w-4 text-accent-text" strokeWidth={1.75} />
        Social
      </h3>
      <div className="space-y-3">
        {social.profiles.map((p) => (
          <Profile key={p.id} workspaceId={workspaceId} profile={p} onChange={reload} />
        ))}
        {social.chats.map((c) => (
          <Chat key={c.id} chat={c} />
        ))}
      </div>
    </Card>
  );
}

function Profile({
  workspaceId,
  profile: p,
  onChange,
}: {
  workspaceId: string;
  profile: Profile;
  onChange: () => void;
}) {
  const [all, setAll] = useState(false);
  const j = p.journey;
  const steps = all ? j.steps : j.steps.slice(0, LATEST_STEPS);
  return (
    <div className="text-[13.5px]" data-testid="outreach-panel-profile">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={p.url}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-accent-text hover:underline"
        >
          {p.name} on {PLATFORMS[p.platform as Platform]}
        </a>
        {j.stage ? (
          <Badge variant={STAGE_TONE[j.stage]} data-testid="outreach-panel-stage">
            {STAGES[j.stage]}
          </Badge>
        ) : null}
        {FRIENDSHIP[p.friendship] ? <Badge>{FRIENDSHIP[p.friendship]}</Badge> : null}
      </div>
      {j.why.length ? (
        <div className="mt-0.5 text-[12.5px] text-text-3" data-testid="outreach-panel-why">
          {j.why.join(' · ')}
        </div>
      ) : null}
      {j.nextStep ? (
        <p className="mt-1 text-[12.5px] text-text-2" data-testid="outreach-panel-next">
          {W.nextStepLabel}: {j.nextStep}
        </p>
      ) : null}
      {j.lead ? (
        <p className="mt-1 text-[12.5px]" data-testid="outreach-panel-lead">
          <Link
            href={`/app/w/${workspaceId}/leads/${j.lead.leadId}`}
            className="text-accent-text hover:underline"
          >
            {leadWords(j.lead)}
          </Link>
        </p>
      ) : null}
      {p.owner ? (
        <p className="mt-1 text-[12.5px] text-text-3" data-testid="outreach-panel-owner">
          {OWNER_WORDS.personNote(p.owner)}
        </p>
      ) : null}
      {j.lead?.afterDemo ? (
        <AfterDemo workspaceId={workspaceId} profileId={p.id} name={p.name} onChange={onChange} />
      ) : null}
      {p.intro.length ? (
        <ul className="mt-1 text-[13px] text-text-2">
          {p.intro.slice(0, 4).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      <div className="mt-0.5 text-[12px] text-text-3">
        {p.mutualFriends !== null ? `${p.mutualFriends} mutual friends · ` : ''}
        Seen {relativeTime(p.lastSeenAt)}
      </div>
      {j.groups.length ? (
        <p className="mt-1.5 text-[12.5px] text-text-2" data-testid="outreach-panel-groups">
          Found in{' '}
          {j.groups.map((g, i) => (
            <span key={g.groupId}>
              {i ? ', ' : ''}
              <Link
                href={outreachHref(workspaceId, { view: 'groups', group: g.groupId })}
                className="text-accent-text hover:underline"
              >
                {g.name ?? 'a group'}
              </Link>
            </span>
          ))}
        </p>
      ) : null}
      {j.chat?.summary ? (
        <p className="mt-1.5 text-[12.5px] text-text-2" data-testid="outreach-panel-chat">
          <span className="font-medium text-text">Your chat:</span> {j.chat.summary}{' '}
          <span className="text-text-3">
            {j.chat.lastFromMe ? 'You wrote last' : 'They wrote last'},{' '}
            {relativeTime(j.chat.lastAt)}
          </span>
        </p>
      ) : null}
      {steps.length ? (
        <ol
          className="mt-2 space-y-0.5 border-l border-border pl-3"
          data-testid="outreach-panel-steps"
        >
          {steps.map((s, i) => (
            <li key={`${s.at}-${i}`} className="text-[12.5px]">
              {s.postUrl ? (
                <a
                  href={s.postUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-text hover:underline"
                >
                  {journeyStepWords(s, p.platform as Platform)}
                </a>
              ) : (
                <span>{journeyStepWords(s, p.platform as Platform)}</span>
              )}
              {s.group ? (
                <span className="text-text-3"> · from {s.group.name ?? 'a group'}</span>
              ) : null}
              <span className="text-text-3"> · {relativeTime(s.at)}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {j.steps.length > LATEST_STEPS ? (
        <button
          type="button"
          className="mt-1 text-[12.5px] text-accent-text hover:underline"
          onClick={() => setAll(!all)}
        >
          {all ? 'Show the latest only' : `Show all ${j.steps.length} steps`}
        </button>
      ) : null}
      {all && j.moreSteps ? (
        <p className="mt-0.5 text-[12px] text-text-3">
          And {j.moreSteps.toLocaleString()} older {j.moreSteps === 1 ? 'step' : 'steps'}.
        </p>
      ) : null}
    </div>
  );
}

/** Won or lost after their demo (`outreach.demo.outcome`); lost asks why, and they can leave it blank. */
function AfterDemo({
  workspaceId,
  profileId,
  name,
  onChange,
}: {
  workspaceId: string;
  profileId: string;
  name: string;
  onChange: () => void;
}) {
  const { busy, act } = useAct(onChange);
  const [losing, setLosing] = useState(false);
  const [why, setWhy] = useState('');
  const decide = (outcome: DemoOutcome) =>
    void act(
      outcome,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.demo.outcome', {
            body: {
              workspaceId,
              profileId,
              outcome,
              why: outcome === 'lost' && why.trim() ? why.trim() : null,
            },
          }),
        ),
      D.done(name, outcome),
    );
  return (
    <div className="mt-1.5 rounded-card bg-card-2 p-2.5" data-testid="outreach-panel-after-demo">
      <p className="text-[12.5px] text-text-2">{D.ask}</p>
      {losing ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <Input
            inputSize="sm"
            className="min-w-[12rem] flex-1"
            value={why}
            maxLength={DEMO_LOST_WHY_MOST}
            placeholder={D.why}
            aria-label={D.why}
            onChange={(e) => setWhy(e.target.value)}
            data-testid="outreach-panel-lost-why"
          />
          <Button
            size="sm"
            variant="danger"
            disabled={busy !== null}
            loading={busy === 'lost'}
            onClick={() => decide('lost')}
            data-testid="outreach-panel-mark-lost"
          >
            {D.markLost}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => setLosing(false)}
          >
            {D.cancel}
          </Button>
        </div>
      ) : (
        <div className="mt-1.5 flex gap-2">
          <Button
            size="sm"
            variant="success"
            disabled={busy !== null}
            loading={busy === 'won'}
            onClick={() => decide('won')}
            data-testid="outreach-panel-won"
          >
            {D.won}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => setLosing(true)}
            data-testid="outreach-panel-lost"
          >
            {D.lost}
          </Button>
        </div>
      )}
    </div>
  );
}

function Chat({ chat }: { chat: PersonSocial['chats'][number] }) {
  const [all, setAll] = useState(false);
  const shown = all ? chat.messages : chat.messages.slice(-LATEST);
  return (
    <div className="border-t border-border pt-3 text-[13.5px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <a
          href={chat.url}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-accent-text hover:underline"
        >
          {PLATFORMS[chat.platform as Platform]} chat
        </a>
        <span className="text-[12px] text-text-3">
          {chat.ownerName ? `${chat.ownerName}’s · ` : ''}saved {relativeTime(chat.lastSavedAt)}
        </span>
      </div>
      <ul className="mt-2 space-y-1.5">
        {shown.map((m, i) => (
          <li
            key={`${i}-${m.savedAt}`}
            className={cn(
              'max-w-[90%] rounded-card px-2.5 py-1.5',
              m.from === 'me' ? 'ml-auto bg-accent-soft' : 'bg-card-2',
            )}
          >
            <div className="text-[11.5px] text-text-3">
              {m.from === 'me' ? (chat.ownerName ?? 'You') : (m.sender ?? 'Them')}
              {m.when ? ` · ${m.when}` : ''}
            </div>
            <div className="whitespace-pre-wrap">{m.text}</div>
          </li>
        ))}
      </ul>
      {chat.messages.length > LATEST ? (
        <button
          type="button"
          className="mt-1.5 text-[12.5px] text-accent-text hover:underline"
          onClick={() => setAll(!all)}
        >
          {all ? 'Show the latest only' : `Show all ${chat.messages.length}`}
        </button>
      ) : null}
    </div>
  );
}
