'use client';
/**
 * Pieces of a website chat's editor (Forms → Website chats, and Settings → Website chat): where its button sits on
 * computers and on phones, with a small picture of each, and a colour that is either worked out for you or picked.
 * What they show is what the loader draws (lib/chat/loader.ts): the corner, how far up from its usual spot, and the
 * label beside the icon or only the round icon (or, on phones, no button at all).
 */
import {
  CHAT_LIFT_LIMIT,
  type ChatCorner,
  type ChatDesktopButton,
  type ChatMobileButton,
} from '@hfos/core';
import { MessageCircle, Monitor, Smartphone } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Hint } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';

export interface DevicePlace<B extends string> {
  readonly position: ChatCorner;
  readonly lift: number;
  readonly button: B;
}

const CORNERS = [
  { value: 'right', label: 'Bottom right' },
  { value: 'left', label: 'Bottom left' },
] as const;

/** How much higher, in steps a person can pick at a glance; any number up to the limit can be typed too. */
const LIFTS = [0, 60, 90, 120];

/** One device's corner, lift and button, beside a picture of a screen with the button where it'll be. */
export function DevicePlacement<B extends string>({
  device,
  value,
  onChange,
  buttons,
  label,
  accent,
  text,
}: {
  device: 'desktop' | 'mobile';
  value: DevicePlace<B>;
  onChange: (next: DevicePlace<B>) => void;
  buttons: readonly { readonly value: B; readonly label: string }[];
  /** The button's words. */
  label: string;
  accent: string;
  text: string;
}) {
  const id = useId();
  const phone = device === 'mobile';
  const hidden = value.button === 'hidden';
  const set = (patch: Partial<DevicePlace<B>>) => onChange({ ...value, ...patch });
  return (
    <div
      className="min-w-0 rounded-xl border border-border p-4"
      data-testid={`chat-place-${device}`}
    >
      <p className="flex items-center gap-2 text-[13.5px] font-semibold">
        {phone ? (
          <Smartphone className="h-4 w-4 text-text-3" aria-hidden />
        ) : (
          <Monitor className="h-4 w-4 text-text-3" aria-hidden />
        )}
        {phone ? 'On phones' : 'On computers'}
      </p>
      <div className="mt-3 flex gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div>
            <p className="mb-1.5 text-[13px] font-medium">Button</p>
            <Segmented
              fill
              ariaLabel={`The button ${phone ? 'on phones' : 'on computers'}`}
              value={value.button}
              onChange={(button) => set({ button })}
              options={buttons.map((b) => ({
                ...b,
                testId: `chat-${device}-button-${b.value}`,
              }))}
            />
          </div>
          {hidden ? (
            <Hint className="mt-0">
              No button on phones. Visitors open the chat from a link to <code>#hfos-chat</code> on
              your site, like a Chat link in your menu.
            </Hint>
          ) : (
            <>
              <div>
                <p className="mb-1.5 text-[13px] font-medium">Corner</p>
                <Segmented
                  fill
                  ariaLabel={`Corner ${phone ? 'on phones' : 'on computers'}`}
                  value={value.position}
                  onChange={(position) => set({ position })}
                  options={CORNERS.map((c) => ({ ...c, testId: `chat-${device}-${c.value}` }))}
                />
              </div>
              <div>
                <label htmlFor={`${id}-lift`} className="mb-1.5 block text-[13px] font-medium">
                  Higher up by
                </label>
                <div className="flex flex-wrap items-center gap-1.5">
                  {LIFTS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => set({ lift: n })}
                      aria-pressed={value.lift === n}
                      className={cn(
                        'h-8 rounded-control border px-2.5 text-[12.5px] font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                        value.lift === n
                          ? 'border-text bg-card-2 text-text'
                          : 'border-border text-text-2 hover:bg-card-2',
                      )}
                    >
                      {n ? `${n} px` : 'None'}
                    </button>
                  ))}
                  <Input
                    id={`${id}-lift`}
                    inputSize="sm"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={CHAT_LIFT_LIMIT}
                    step={5}
                    value={String(value.lift)}
                    onChange={(e) => {
                      const n = Math.round(Number(e.target.value));
                      set({
                        lift: Number.isFinite(n) ? Math.max(0, Math.min(CHAT_LIFT_LIMIT, n)) : 0,
                      });
                    }}
                    className="w-[76px]"
                    aria-describedby={`${id}-lift-hint`}
                    data-testid={`chat-${device}-lift`}
                  />
                </div>
                <p id={`${id}-lift-hint`} className="mt-1 text-xs text-text-3">
                  {phone
                    ? 'Raise it above a bar along the bottom of your site, like a Call or Book button.'
                    : `Pixels above its usual spot, up to ${CHAT_LIFT_LIMIT}.`}
                </p>
              </div>
            </>
          )}
        </div>
        <ScreenPicture device={device} place={value} label={label} accent={accent} text={text} />
      </div>
    </div>
  );
}

/** A small screen with the button where it'll sit: a phone at half size, a computer at a third. */
function ScreenPicture({
  device,
  place,
  label,
  accent,
  text,
}: {
  device: 'desktop' | 'mobile';
  place: DevicePlace<string>;
  label: string;
  accent: string;
  text: string;
}) {
  const phone = device === 'mobile';
  const scale = phone ? 0.5 : 1 / 3;
  // The loader's own spacing: 16 px from the edges on a phone, 24 on a computer, 16 or 20 from the bottom.
  const edge = (phone ? 16 : 24) * scale;
  const bottom = ((phone ? 16 : 20) + place.lift) * scale;
  const icon = place.button === 'icon';
  return (
    <div
      aria-hidden
      className={cn(
        'relative flex-none overflow-hidden border border-border-strong bg-card-2',
        phone
          ? 'h-[200px] w-[100px] rounded-[16px]'
          : 'h-[120px] w-[176px] self-start rounded-[8px]',
      )}
      data-testid={`chat-place-${device}-picture`}
    >
      {/* A few lines of a page, so the button reads as sitting on a site. */}
      <div className="absolute inset-x-2 top-3 flex flex-col gap-1.5">
        <i className="h-1.5 w-1/2 rounded-full bg-border-strong" />
        <i className="h-1 w-5/6 rounded-full bg-border" />
        <i className="h-1 w-2/3 rounded-full bg-border" />
      </div>
      {place.button === 'hidden' ? null : (
        <span
          className="absolute inline-flex items-center justify-center gap-[3px] whitespace-nowrap rounded-full font-semibold shadow-[0_2px_6px_rgba(25,29,37,0.3)]"
          style={{
            background: accent,
            color: text,
            ...(place.position === 'left' ? { left: edge } : { right: edge }),
            bottom,
            height: 54 * scale,
            width: icon ? 54 * scale : undefined,
            paddingInline: icon ? 0 : 8 * scale + 2,
            fontSize: 15 * scale,
            maxWidth: phone ? 84 : 150,
          }}
        >
          <MessageCircle style={{ width: 22 * scale, height: 22 * scale }} className="flex-none" />
          {icon ? null : <span className="truncate">{label}</span>}
        </span>
      )}
    </div>
  );
}

export const DESKTOP_BUTTONS: readonly { value: ChatDesktopButton; label: string }[] = [
  { value: 'label', label: 'Label' },
  { value: 'icon', label: 'Icon only' },
];
export const MOBILE_BUTTONS: readonly { value: ChatMobileButton; label: string }[] = [
  { value: 'label', label: 'Label' },
  { value: 'icon', label: 'Icon only' },
  { value: 'hidden', label: 'Hidden' },
];

/** A colour worked out for you ("Automatic"), or one picked: the choice, the picker and the hex. */
export function ColorChoice({
  title,
  autoLabel,
  value,
  shownAuto,
  onChange,
  testId,
  hint,
}: {
  title: string;
  autoLabel: string;
  /** The picked colour; null for automatic. */
  value: string | null;
  /** The colour automatic gives now, for the swatch and the picker's starting point. */
  shownAuto: string;
  onChange: (next: string | null) => void;
  testId: string;
  hint?: ReactNode;
}) {
  const id = useId();
  return (
    <div data-testid={testId}>
      <p className="mb-1.5 text-[13px] font-medium" id={id}>
        {title}
      </p>
      <div className="flex flex-wrap items-center gap-2.5">
        <Segmented
          ariaLabel={title}
          value={value === null ? 'auto' : 'pick'}
          onChange={(v) => onChange(v === 'auto' ? null : (value ?? shownAuto))}
          options={[
            { value: 'auto', label: autoLabel, testId: `${testId}-auto` },
            { value: 'pick', label: 'Pick a colour', testId: `${testId}-pick` },
          ]}
        />
        <label
          className={cn(
            'relative inline-flex h-7 w-7 flex-none cursor-pointer rounded-full border border-[color-mix(in_oklab,var(--text)_16%,transparent)] focus-within:ring-[3px] focus-within:ring-ring',
            value === null && 'opacity-60',
          )}
          style={{ background: value ?? shownAuto }}
          title={value === null ? 'Pick a colour' : value}
        >
          <input
            type="color"
            value={value ?? shownAuto}
            onChange={(e) => onChange(e.target.value.toLowerCase())}
            className="absolute inset-0 cursor-pointer opacity-0"
            aria-labelledby={id}
            data-testid={`${testId}-input`}
          />
        </label>
        <span className="font-mono text-xs text-text-3">{value ?? shownAuto}</span>
      </div>
      {hint ? <Hint>{hint}</Hint> : null}
    </div>
  );
}
