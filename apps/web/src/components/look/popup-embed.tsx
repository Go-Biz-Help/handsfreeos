'use client';
/**
 * A form or booking page in a pop-up on the business's own website (core's look/popup.ts): how it opens, the
 * button's words or the seconds to wait, and the code to paste. Nothing is saved: everything is in the code. The
 * form's Share tab and the calendar's Embed both show it, and the Assistant hands out the same code.
 */
import {
  POPUP_LABEL_MAX,
  POPUP_SECONDS_DEFAULT,
  POPUP_SECONDS_MAX,
  POPUP_SECONDS_MIN,
  POPUP_WORDS as W,
  popupSeconds,
  popupSnippet,
  type PopupButtonLook,
  type PopupOpens,
} from '@hfos/core';
import { useState } from 'react';
import { CopyField } from '@/components/ui/copy-field';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';

export function PopupEmbed({
  url,
  appOrigin,
  name,
  defaultLabel,
  look,
  testId = 'popup',
}: {
  /** The page's public link. */
  url: string;
  appOrigin: string;
  name: string;
  /** The button's words to start with ("Book now"). */
  defaultLabel: string;
  /** The page's own button colour, words and corners, for the button in the code. */
  look: PopupButtonLook | null;
  testId?: string;
}) {
  const [opens, setOpens] = useState<PopupOpens>('button');
  const [label, setLabel] = useState(defaultLabel);
  const [seconds, setSeconds] = useState(String(POPUP_SECONDS_DEFAULT));
  const code = popupSnippet({
    url,
    appOrigin,
    name,
    opens,
    label,
    seconds: Number(seconds),
    look,
  });
  const note = opens === 'button' ? W.buttonNote : opens === 'after' ? W.autoNote : W.leaveNote;
  return (
    <div className="flex flex-col gap-4" data-testid={testId}>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">{W.opens}</span>
        <Segmented
          ariaLabel={W.opens}
          value={opens}
          onChange={setOpens}
          options={[
            { value: 'button', label: W.button, testId: `${testId}-opens-button` },
            { value: 'after', label: W.after, testId: `${testId}-opens-after` },
            { value: 'leave', label: W.leave, testId: `${testId}-opens-leave` },
          ]}
        />
      </div>
      {opens === 'button' ? (
        <Field label={W.label} htmlFor={`${testId}-label`}>
          <div className="flex flex-wrap items-center gap-3">
            <Input
              id={`${testId}-label`}
              className="max-w-[260px]"
              value={label}
              maxLength={POPUP_LABEL_MAX}
              onChange={(e) => setLabel(e.target.value)}
              data-testid={`${testId}-label`}
            />
            {/* How it looks on the site: the page's own button. */}
            <span
              aria-hidden
              className="inline-flex h-10 items-center px-5 text-[15px] font-semibold"
              style={{
                background: look?.background ?? 'var(--accent)',
                color: look?.color ?? '#fff',
                borderRadius: look?.radius ?? '8px',
              }}
              data-testid={`${testId}-button-preview`}
            >
              {label.trim() || 'Open'}
            </span>
          </div>
        </Field>
      ) : null}
      {opens === 'after' ? (
        <Field
          label={W.seconds}
          htmlFor={`${testId}-seconds`}
          hint={`Between ${POPUP_SECONDS_MIN} and ${POPUP_SECONDS_MAX}.`}
        >
          <Input
            id={`${testId}-seconds`}
            type="number"
            inputMode="numeric"
            min={POPUP_SECONDS_MIN}
            max={POPUP_SECONDS_MAX}
            className="w-28"
            value={seconds}
            onChange={(e) => setSeconds(e.target.value)}
            onBlur={() => setSeconds(String(popupSeconds(Number(seconds))))}
            data-testid={`${testId}-seconds`}
          />
        </Field>
      ) : null}
      <div className="flex flex-col gap-1.5" data-testid={`${testId}-code`} data-code={code}>
        <span className="text-[13px] font-medium">{W.code}</span>
        <CopyField value={code} label="Copy the code" copied="Copied the code" />
        <p className="text-[12.5px] text-text-3">{note}</p>
      </div>
    </div>
  );
}
