'use client';
/**
 * The phone number setup's answers that can be changed again later, each as one editor: what rings, what happens when
 * nobody picks up, and quiet hours. The guided setup shows them as its questions, and Settings → Texting & calls opens
 * the same ones behind Change, so a setting is asked and changed in the same words.
 */
import {
  PHONE_SETUP_GREETING_MAX,
  PHONE_SETUP_MAX_PHONES,
  PHONE_SETUP_RING_SECONDS,
  PHONE_SETUP_WORDS as W,
  phoneSetupClock,
  phoneSetupDefaultGreeting,
  type PhoneSetupAnswers,
  type PhoneSetupContext,
  type PhoneSetupTeammateMode,
} from '@hfos/core';
import { Globe, Phone, Plus, Trash2, Volume2 } from 'lucide-react';
import { useEffect, useId, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ChoiceTile, Choices, GuidedNote } from '@/components/guided-setup/frame';
import { ChannelIcon } from '@/components/inbox/bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldError, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export interface PhoneEditorProps {
  readonly answers: PhoneSetupAnswers;
  readonly set: (patch: Partial<PhoneSetupAnswers>) => void;
  /** What stopped Next or Save, by the answer it is about (phoneSetupProblems). */
  readonly problems: Readonly<Record<string, string>>;
  readonly ctx: PhoneSetupContext;
}

/** A few short choices in a row, one picked. */
function Pills<T extends string | number>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: T;
  options: readonly { readonly value: T; readonly label: string }[];
  onChange: (v: T) => void;
  testId: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          data-testid={`${testId}-${o.value}`}
          className={cn(
            'h-9 rounded-control border px-3 text-[13.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
            o.value === value
              ? 'border-accent bg-accent-soft text-accent-text'
              : 'border-border-strong bg-card text-text hover:bg-card-2',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * What rings when a customer calls: HandsFreeOS always, and up to three cell or desk phones beside it, with what
 * those phones show. `switches`: each phone's own on and off, for a day off without removing it (Settings).
 */
export function RingEditor({
  answers: a,
  set,
  problems,
  ctx,
  switches = false,
}: PhoneEditorProps & { switches?: boolean }) {
  const uid = useId();
  const phones = a.phones;
  // Ticking "a phone too" opens its first row, so there is somewhere to type straight away.
  useEffect(() => {
    if (a.morePhones && phones.length === 0)
      set({ phones: [{ label: '', number: '', enabled: true }] });
  }, [a.morePhones, phones.length]);
  const change = (i: number, patch: Partial<(typeof phones)[number]>) =>
    set({ phones: phones.map((p, at) => (at === i ? { ...p, ...patch } : p)) });

  return (
    <div className="flex flex-col gap-2.5" data-testid="ring-editor">
      <div className="flex items-start gap-3 rounded-menu border border-border bg-card p-3.5">
        <ChannelIcon icon={Globe} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 font-semibold">
            {W.ring.app} <Badge variant="gray">{W.ring.appAlways}</Badge>
          </div>
          <div className="text-[13.5px] leading-snug text-text-2">{W.ring.appHint}</div>
        </div>
      </div>

      <div
        className={cn(
          'rounded-menu border transition-colors',
          a.morePhones ? 'border-accent bg-accent-soft' : 'border-border bg-card',
        )}
      >
        <label className="flex cursor-pointer items-start gap-3 p-3.5">
          <input
            type="checkbox"
            className="mt-0.5 h-[18px] w-[18px] flex-none cursor-pointer rounded-[5px] border border-border-strong accent-accent"
            checked={a.morePhones}
            onChange={(e) => set({ morePhones: e.target.checked })}
            data-testid="phone-more"
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="font-semibold">{W.ring.more}</span>
            <span className="text-[13.5px] leading-snug text-text-2">{W.ring.moreHint}</span>
          </span>
        </label>
        {a.morePhones ? (
          <div className="flex flex-col gap-3 px-3.5 pb-3.5 sm:pl-[44px]">
            {phones.map((p, i) => {
              const labelId = `${uid}-label-${i}`;
              const numberId = `${uid}-number-${i}`;
              const labelError = problems[`phones.${i}.label`];
              const numberError = problems[`phones.${i}.number`];
              return (
                <div
                  key={i}
                  role="group"
                  aria-label={p.label.trim() || `Phone ${i + 1}`}
                  className="flex flex-col gap-1"
                >
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="min-w-[150px] flex-1">
                      <Label htmlFor={labelId}>{W.ring.whose}</Label>
                      <Input
                        id={labelId}
                        value={p.label}
                        maxLength={40}
                        placeholder={W.ring.whosePlaceholder}
                        invalid={!!labelError}
                        onChange={(e) => change(i, { label: e.target.value })}
                        data-testid={`phone-label-${i}`}
                      />
                    </div>
                    <div className="min-w-[150px] flex-1">
                      <Label htmlFor={numberId}>{W.ring.its}</Label>
                      <Input
                        id={numberId}
                        type="tel"
                        inputMode="tel"
                        autoComplete="off"
                        value={p.number}
                        maxLength={40}
                        placeholder="(256) 555-0117"
                        invalid={!!numberError}
                        onChange={(e) => change(i, { number: e.target.value })}
                        data-testid={`phone-number-${i}`}
                      />
                    </div>
                    <div className="flex h-10 items-center gap-1.5">
                      {switches ? (
                        <Switch
                          checked={p.enabled}
                          label={W.ring.rings}
                          onChange={(on) => change(i, { enabled: on })}
                          testId={`phone-rings-${i}`}
                        />
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon"
                        title={W.ring.remove(p.label.trim())}
                        aria-label={W.ring.remove(p.label.trim())}
                        onClick={() => {
                          const left = phones.filter((_, at) => at !== i);
                          set(left.length ? { phones: left } : { phones: left, morePhones: false });
                        }}
                        data-testid={`phone-remove-${i}`}
                      >
                        <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                      </Button>
                    </div>
                  </div>
                  {labelError ? <FieldError>{labelError}</FieldError> : null}
                  {numberError ? <FieldError>{numberError}</FieldError> : null}
                </div>
              );
            })}
            {problems['phones'] ? <FieldError>{problems['phones']}</FieldError> : null}
            {phones.length < PHONE_SETUP_MAX_PHONES ? (
              <Button
                variant="secondary"
                size="sm"
                className="self-start"
                onClick={() =>
                  set({ phones: [...phones, { label: '', number: '', enabled: true }] })
                }
                data-testid="phone-add"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
                {phones.length ? W.ring.add : W.ring.addFirst}
              </Button>
            ) : null}
            {switches && phones.length ? (
              <p className="text-[13px] text-text-2">{W.ring.used(phones.length)}</p>
            ) : null}

            <fieldset className="mt-1 flex flex-col gap-2" data-testid="caller-id">
              <legend className="mb-1.5 text-[13.5px] font-semibold">{W.ring.showsTitle}</legend>
              <Choices label={W.ring.showsTitle}>
                <ChoiceTile
                  selected={a.callerId === 'customer'}
                  onSelect={() => set({ callerId: 'customer' })}
                  title={W.ring.showsCustomer}
                  hint={W.ring.showsCustomerHint}
                  testId="caller-id-customer"
                />
                <ChoiceTile
                  selected={a.callerId === 'business'}
                  onSelect={() => set({ callerId: 'business' })}
                  title={W.ring.showsBusiness}
                  hint={W.ring.showsBusinessHint}
                  testId="caller-id-business"
                />
              </Choices>
            </fieldset>
          </div>
        ) : null}
      </div>
      {a.morePhones ? (
        <p className="flex items-start gap-2 text-[13.5px] leading-snug text-text-2">
          <Phone className="mt-0.5 h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
          {W.ring.press1(ctx.businessName)}
        </p>
      ) : null}
    </div>
  );
}

/** Reads the greeting aloud in the browser's own voice, so they hear it before a caller does. */
function playGreeting(text: string) {
  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
    toast.error('Your browser can’t play the greeting');
    return;
  }
  const speech = new SpeechSynthesisUtterance(text);
  speech.lang = 'en-US';
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(speech);
}

/** How long the phones ring, and what a caller gets after that: the AI teammate, the voicemail, or nothing. */
export function MissedEditor({ answers: a, set, problems, ctx }: PhoneEditorProps) {
  const uid = useId();
  const mate = ctx.teammate;
  const name = mate?.name ?? null;
  const usual = phoneSetupDefaultGreeting(ctx.businessName);
  const locked = !!mate && !mate.canManage;
  // A greeting still reading aloud stops when the screen goes.
  useEffect(
    () => () => {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    },
    [],
  );
  const when: readonly { value: PhoneSetupTeammateMode; label: string }[] = [
    { value: 'no_answer', label: W.missed.when.no_answer },
    { value: 'after_hours', label: W.missed.when.after_hours },
    { value: 'always', label: W.missed.when.always },
  ];
  const seconds = (PHONE_SETUP_RING_SECONDS as readonly number[]).includes(a.ringSeconds)
    ? PHONE_SETUP_RING_SECONDS
    : [...PHONE_SETUP_RING_SECONDS, a.ringSeconds].sort((x, y) => x - y);

  return (
    <div className="flex flex-col gap-4" data-testid="missed-editor">
      <div className="flex flex-wrap items-center gap-2 text-[13.5px] text-text-2">
        <span className="font-semibold text-text">{W.missed.ringFor}</span>
        <Pills
          label={W.missed.ringFor}
          value={a.ringSeconds}
          options={seconds.map((n) => ({ value: n, label: W.missed.seconds(n) }))}
          onChange={(n) => set({ ringSeconds: n })}
          testId="ring-seconds"
        />
        <span>{W.missed.rings(a.ringSeconds)}</span>
      </div>
      <Choices label={W.missed.title}>
        <ChoiceTile
          selected={a.then === 'teammate'}
          onSelect={() => set({ then: 'teammate' })}
          title={W.missed.teammate(name)}
          hint={locked ? W.missed.cantManage : W.missed.teammateHint}
          best={locked ? undefined : W.best}
          disabled={locked && a.then !== 'teammate'}
          testId="missed-teammate"
        >
          {!mate ? <Note>{W.missed.noTeammate}</Note> : null}
          {mate && !mate.on ? <Note>{W.missed.teammateOff(mate.name)}</Note> : null}
          <div className="flex flex-col gap-1.5">
            <span className="text-[13.5px] font-semibold">{W.missed.whenTitle(name)}</span>
            <Pills
              label={W.missed.whenTitle(name)}
              value={a.teammateMode}
              options={when}
              onChange={(v) => set({ teammateMode: v })}
              testId="teammate-when"
            />
          </div>
          <p className="text-[13px] leading-snug text-text-2">{W.missed.teammateCost(name)}</p>
        </ChoiceTile>
        <ChoiceTile
          selected={a.then === 'voicemail'}
          onSelect={() => set({ then: 'voicemail' })}
          title={W.missed.voicemail}
          hint={W.missed.voicemailHint}
          testId="missed-voicemail"
        >
          <div>
            <Label htmlFor={`${uid}-greeting`}>{W.missed.greeting}</Label>
            <Textarea
              id={`${uid}-greeting`}
              className="min-h-[76px]"
              maxLength={PHONE_SETUP_GREETING_MAX}
              value={a.greeting}
              placeholder={usual}
              invalid={!!problems['greeting']}
              onChange={(e) => set({ greeting: e.target.value })}
              data-testid="voicemail-greeting"
            />
            {problems['greeting'] ? (
              <FieldError>{problems['greeting']}</FieldError>
            ) : (
              <p className="mt-1 text-[13px] text-text-3">
                {a.greeting.trim()
                  ? W.missed.greetingHint
                  : `Leave it empty and callers hear the one shown. ${W.missed.greetingHint}`}
              </p>
            )}
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() => playGreeting(a.greeting.trim() || usual)}
            data-testid="voicemail-play"
          >
            <Volume2 className="h-3.5 w-3.5" strokeWidth={1.5} />
            Play it
          </Button>
        </ChoiceTile>
        <ChoiceTile
          selected={a.then === 'nothing'}
          onSelect={() => set({ then: 'nothing' })}
          title={W.missed.nothing}
          hint={W.missed.nothingHint}
          testId="missed-nothing"
        />
      </Choices>
      {problems['then'] ? <FieldError>{problems['then']}</FieldError> : null}
    </div>
  );
}

const Note = ({ children }: { children: ReactNode }) => (
  <p className="rounded-control bg-card px-3 py-2 text-[13px] leading-snug text-text-2">
    {children}
  </p>
);

const HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);

/** When automatic texts wait: overnight, hours they pick, or never. */
export function QuietEditor({
  answers: a,
  set,
  problems,
  timezone,
}: PhoneEditorProps & { timezone: string }) {
  const uid = useId();
  const city = timezone.split('/').pop()?.replace(/_/g, ' ') ?? timezone;
  // A time saved off the hour (by the Assistant, say) stays in the list.
  const times = (now: string) => (HOURS.includes(now) ? HOURS : [...HOURS, now].sort());
  return (
    <div className="flex flex-col gap-4" data-testid="quiet-editor">
      <Choices label={W.quiet.title}>
        <ChoiceTile
          selected={a.quiet === 'night'}
          onSelect={() => set({ quiet: 'night' })}
          title={W.quiet.night}
          hint={W.quiet.nightHint}
          best={W.best}
          testId="quiet-night"
        />
        <ChoiceTile
          selected={a.quiet === 'custom'}
          onSelect={() => set({ quiet: 'custom' })}
          title={W.quiet.custom}
          hint={W.quiet.customHint}
          testId="quiet-custom"
        >
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label htmlFor={`${uid}-stop`}>{W.quiet.stop}</Label>
              <Select
                id={`${uid}-stop`}
                className="w-[130px]"
                value={a.quietStart}
                onChange={(e) => set({ quietStart: e.target.value })}
                data-testid="quiet-start"
              >
                {times(a.quietStart).map((t) => (
                  <option key={t} value={t}>
                    {phoneSetupClock(t)}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor={`${uid}-start`}>{W.quiet.start}</Label>
              <Select
                id={`${uid}-start`}
                className="w-[130px]"
                value={a.quietEnd}
                onChange={(e) => set({ quietEnd: e.target.value })}
                data-testid="quiet-end"
              >
                {times(a.quietEnd).map((t) => (
                  <option key={t} value={t}>
                    {phoneSetupClock(t)}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {problems['quietEnd'] ? <FieldError>{problems['quietEnd']}</FieldError> : null}
        </ChoiceTile>
        <ChoiceTile
          selected={a.quiet === 'never'}
          onSelect={() => set({ quiet: 'never' })}
          title={W.quiet.never}
          hint={W.quiet.neverHint}
          testId="quiet-never"
        />
      </Choices>
      {problems['quiet'] ? <FieldError>{problems['quiet']}</FieldError> : null}
      <GuidedNote>
        {W.quiet.stillCan} {W.quiet.zone(city)}
      </GuidedNote>
    </div>
  );
}
