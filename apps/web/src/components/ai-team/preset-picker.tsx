'use client';
import {
  inferTeammateLabels,
  teammateConfigFromPreset,
  type DisclosureMode,
  type TeammateCatalogs,
  type TeammatePresetKey,
} from '@hfos/core';
import {
  AlertTriangle,
  CalendarCheck,
  ClipboardCheck,
  Info,
  Plus,
  ShieldCheck,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Hint, Label } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { teammateActions } from '@/lib/ai-team/actions';
import { firstTextPreview, skillsOn } from '@/lib/ai-team/describe';
import { errorMessage } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { TeammateLabelChips } from './chips';
import { AI_SOFT, AI_TEXT } from './mark';
import { Callout, Choice, Note, RadioDot } from './parts';

interface PresetCopy {
  readonly title: string;
  readonly description: string;
  readonly icon: LucideIcon;
}

/** The answers to "How should your AI teammate work?", in the canvas's words. */
export const PRESET_COPY: Record<TeammatePresetKey, PresetCopy> = {
  lead_responder: {
    title: 'Lead Responder',
    description: 'Replies to new leads within a minute and answers their questions.',
    icon: Zap,
  },
  lead_qualifier: {
    title: 'Lead Qualifier',
    description: 'Asks your questions, then tells you who’s a good fit and moves them along.',
    icon: ClipboardCheck,
  },
  appointment_coordinator: {
    title: 'Appointment Coordinator',
    description: 'Answers questions, and books, moves or cancels visits on your calendars.',
    icon: CalendarCheck,
  },
  blank: {
    title: 'Blank',
    description: 'Just the basics. Pick the skills yourself in the builder.',
    icon: Plus,
  },
};

const ORDER: readonly TeammatePresetKey[] = [
  'lead_responder',
  'lead_qualifier',
  'appointment_coordinator',
  'blank',
];

/**
 * Setting up the teammate: a preset (which only turns skills on), its name, and how it says it's AI. It's
 * created turned off, and starts with training wheels once someone turns it on.
 */
export function TeammatePresetPicker({
  workspaceId,
  workspaceName,
  catalogs,
}: {
  workspaceId: string;
  workspaceName: string;
  catalogs: TeammateCatalogs;
}) {
  const router = useRouter();
  const [pick, setPick] = useState<TeammatePresetKey>('lead_responder');
  const [name, setName] = useState('Ava');
  const [disclosure, setDisclosure] = useState<DisclosureMode>('first_message');
  const [busy, setBusy] = useState(false);
  const nameOr = name.trim() || 'Your teammate';

  // What each preset turns on here: the same context the server creates with.
  const configs = useMemo(() => {
    const ctx = {
      industry: catalogs.industry,
      emailAddressId: catalogs.emailAddresses[0]?.id ?? null,
      widgetId: catalogs.chatWidgets[0]?.id ?? null,
      calendarIds: catalogs.calendars
        .filter((c) => !c.archived && c.bookableOnline)
        .map((c) => c.id),
    };
    return Object.fromEntries(ORDER.map((k) => [k, teammateConfigFromPreset(k, ctx)])) as Record<
      TeammatePresetKey,
      ReturnType<typeof teammateConfigFromPreset>
    >;
  }, [catalogs]);
  const labels = inferTeammateLabels(configs[pick]).tags;
  const approvals = configs[pick].autonomy.approvalsNeeded;

  async function create() {
    setBusy(true);
    try {
      await teammateActions(workspaceId).create({ preset: pick, name: name.trim(), disclosure });
      toast.success(
        `Created ${name.trim()}. Turn it on when you’re ready: it starts with training wheels.`,
      );
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5 md:px-7 md:py-6" data-testid="teammate-preset-picker">
      <h2 className="text-lg font-semibold tracking-tight">How should your AI teammate work?</h2>
      <p className="mb-[18px] mt-1.5 flex items-start gap-2 text-[13px] text-text-2">
        <Info className="mt-px h-4 w-4 flex-none" strokeWidth={1.5} />
        Pick the closest match. Presets only turn skills on. You can change anything later.
      </p>
      <div
        role="radiogroup"
        aria-label="How it works"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        {ORDER.map((key) => {
          const c = PRESET_COPY[key];
          const Icon = c.icon;
          const on = pick === key;
          const turns = skillsOn(configs[key]);
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={on}
              data-testid={`teammate-preset-${key}`}
              onClick={() => setPick(key)}
              className={cn(
                'flex min-h-[150px] flex-col gap-2.5 rounded-menu border px-4 py-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                on
                  ? 'border-accent bg-accent-soft shadow-[0_0_0_1px_var(--accent)]'
                  : 'border-border-strong bg-card hover:bg-card-2',
                key === 'blank' && !on && 'border-dashed',
              )}
            >
              <span className="flex w-full items-center gap-2.5">
                <span
                  className={cn(
                    'inline-flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[9px]',
                    AI_SOFT,
                    AI_TEXT,
                  )}
                >
                  <Icon className="h-4 w-4" strokeWidth={1.75} />
                </span>
                <span className="flex-1 text-[15px] font-semibold leading-tight">{c.title}</span>
                <RadioDot on={on} />
              </span>
              <span className="text-[13px] leading-[1.45] text-text-2">{c.description}</span>
              <span className="mt-auto text-xs text-text-3">
                Turns on: {turns.length ? turns.join(', ') : 'nothing yet'}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 border-t border-border pt-[18px] md:grid-cols-2">
        <div>
          <Label htmlFor="teammate-name">Name</Label>
          <Input
            id="teammate-name"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            data-testid="teammate-name-input"
          />
          <Hint>Customers see this name. Your teammate never pretends to be a person.</Hint>
        </div>
        <div>
          <Label>It starts out as</Label>
          <div className="flex min-h-10 items-center">
            {labels.length === 1 && labels[0] === 'custom' ? (
              <span className="text-[13px] text-text-3">No labels until a skill is on</span>
            ) : (
              <TeammateLabelChips tags={labels} testId="teammate-preset-labels" />
            )}
          </div>
          <Hint>Labels describe the skills that are on. They never lock anything.</Hint>
        </div>
      </div>

      <div className="mt-5">
        <div className="mb-2 text-[13px] font-medium" id="teammate-disclosure-label">
          How does {nameOr} tell people it’s AI?
        </div>
        <div
          role="radiogroup"
          aria-labelledby="teammate-disclosure-label"
          className="grid grid-cols-1 gap-3 md:grid-cols-2"
        >
          <Choice
            on={disclosure === 'first_message'}
            onSelect={() => setDisclosure('first_message')}
            title="Says it’s AI in its first message"
            badge={
              <Badge variant="ok" className="h-5 text-[11.5px]">
                Recommended
              </Badge>
            }
            description={`“${firstTextPreview(nameOr, 'first_message', workspaceName)}”`}
            testId="teammate-disclosure-first_message"
          />
          <Choice
            on={disclosure === 'when_asked'}
            onSelect={() => setDisclosure('when_asked')}
            title="Only when asked"
            description="It answers truthfully whenever someone asks if they’re talking to a bot."
            testId="teammate-disclosure-when_asked"
          >
            {disclosure !== 'when_asked' ? (
              <span className="flex items-center gap-1.5 text-xs text-warning-text">
                <AlertTriangle className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
                Not for California customers. See the note when you pick it.
              </span>
            ) : null}
          </Choice>
        </div>
        {disclosure === 'when_asked' ? (
          <Callout tone="warning" icon={AlertTriangle} className="mt-3">
            <strong className="font-semibold">California law.</strong> A bot that helps sell to or
            book California customers has to say it’s a bot up front. If you have customers there,
            pick the first option, or check with a lawyer before using this one.
          </Callout>
        ) : null}
        <Note icon={ShieldCheck} className="mt-3">
          Either way, {nameOr} never says it’s a person. A sincere “are you a real person?” always
          gets the truth, and a check blocks any reply that claims to be human.
        </Note>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-[18px]">
        <span className="flex min-w-[240px] flex-1 items-start gap-2 text-xs text-text-3">
          <ShieldCheck className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.5} />
          It starts with training wheels: every message to a customer waits for your OK until{' '}
          {approvals} are approved.
        </span>
        <Button
          loading={busy}
          disabled={!name.trim()}
          onClick={() => void create()}
          data-testid="teammate-create"
        >
          Create {name.trim() || 'teammate'}
        </Button>
      </div>
    </Card>
  );
}
