'use client';
/**
 * A website chat's design (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md, part 4), in its Look card: Match my
 * website, the font and corners (the brand kit's unless picked), a face in the top bar from Your pictures, and the
 * greeting bubble beside the button. Each lands in the Look card's unsaved changes, saved with the rest.
 */
import {
  CHAT_BUBBLE_AFTER_MAX,
  CHAT_BUBBLE_AFTER_MIN,
  CHAT_BUBBLE_MAX,
  CHAT_CORNERS,
  CHAT_DESIGN_WORDS as W,
  FORM_DEFAULT_FONT,
  FORM_FONTS,
  siteNameOf,
  type ChatCorners,
  type PictureRef,
} from '@hfos/core';
import { Wand2 } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { PicturePicker } from '@/components/look/picture-picker';
import { Button } from '@/components/ui/button';
import { FieldError, Hint, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { errorMessage } from '@/lib/api/client';
import { workerPost } from '@/lib/api/worker';

export interface ChatDesignDraft {
  font: string | null;
  corners: ChatCorners | null;
  bubble: string;
  bubbleAfter: number;
  face: PictureRef | null;
}

/** What the worker hands back for a chat's Match my website (apps/worker/src/http/website-style.ts). */
export interface MatchedChatLook {
  readonly site: string;
  readonly accentColor: string | null;
  readonly textColor: string | null;
  readonly font: string | null;
  readonly corners: ChatCorners | null;
  readonly fontNote: string | null;
}

const CORNER_WORDS: Record<ChatCorners, string> = {
  square: 'Square',
  slight: 'Slightly round',
  round: 'Round',
};
const KIT = 'kit';

export function ChatDesignFields({
  workspaceId,
  draft,
  kit,
  website,
  errors,
  onChange,
  onMatched,
}: {
  workspaceId: string;
  draft: ChatDesignDraft;
  /** The brand kit's font and corners (Settings → Workspace), which a chat that hasn't picked its own follows. */
  kit: { readonly font: string | null; readonly corners: ChatCorners | null };
  /** The chat's first site, or the business's website: what Match my website reads unless another is typed. */
  website: string | null;
  errors: Record<string, string>;
  onChange: (patch: Partial<ChatDesignDraft>) => void;
  onMatched: (found: MatchedChatLook) => void;
}) {
  const fontId = useId();
  const bubbleId = useId();
  const afterId = useId();
  const siteId = useId();
  const [site, setSite] = useState(website ? siteNameOf(website) : '');
  const [busy, setBusy] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const fonts =
    !draft.font || FORM_FONTS.some((f) => f.name === draft.font)
      ? FORM_FONTS
      : [...FORM_FONTS, { name: draft.font, weights: '', kind: 'sans' as const }];
  const kitFont = kit.font ?? FORM_DEFAULT_FONT;

  async function match() {
    setBusy(true);
    setMatchError(null);
    try {
      const found = await workerPost<MatchedChatLook>('/v1/chat/website-style', {
        workspaceId,
        ...(site.trim() ? { site: site.trim() } : {}),
      });
      onMatched(found);
      toast.success(`Matched to ${siteNameOf(found.site)}. Check it, then save.`);
      if (found.fontNote) toast.message(found.fontNote);
    } catch (e) {
      setMatchError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 flex flex-col gap-4 border-t border-border pt-4" data-testid="chat-design">
      <div>
        <label htmlFor={siteId} className="block text-[13px] font-medium">
          {W.match}
        </label>
        <p className="mb-2 mt-0.5 text-[12.5px] text-text-3">
          {W.matchHint} You can change anything after.
        </p>
        <div className="flex gap-2">
          <Input
            id={siteId}
            inputSize="sm"
            value={site}
            placeholder="yourwebsite.com"
            onChange={(e) => setSite(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void match();
              }
            }}
            data-testid="chat-match-site"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void match()}
            loading={busy}
            data-testid="chat-match"
          >
            <Wand2 className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            Match
          </Button>
        </div>
        <FieldError>{matchError}</FieldError>
      </div>

      <div>
        <Label htmlFor={fontId}>{W.font}</Label>
        <Select
          id={fontId}
          selectSize="sm"
          value={draft.font ?? KIT}
          onChange={(e) => onChange({ font: e.target.value === KIT ? null : e.target.value })}
          aria-invalid={!!errors.font || undefined}
          data-testid="chat-font"
        >
          <option value={KIT}>
            {W.useKit} ({kitFont})
          </option>
          {fonts.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}
            </option>
          ))}
        </Select>
        {errors.font ? <FieldError>{errors.font}</FieldError> : <Hint>{W.fontHint}</Hint>}
      </div>

      <div>
        <p className="mb-1.5 text-[13px] font-medium">{W.corners}</p>
        <Segmented
          ariaLabel={W.corners}
          value={draft.corners ?? KIT}
          onChange={(v) => onChange({ corners: v === KIT ? null : (v as ChatCorners) })}
          options={[
            { value: KIT, label: 'Brand kit’s', testId: 'chat-corners-kit' },
            ...CHAT_CORNERS.map((c) => ({
              value: c,
              label: CORNER_WORDS[c],
              testId: `chat-corners-${c}`,
            })),
          ]}
        />
        <Hint>
          {kit.corners
            ? `Your brand kit’s are ${CORNER_WORDS[kit.corners].toLowerCase()}.`
            : 'Your brand kit has none yet, so the chat keeps its usual soft corners and round button.'}
        </Hint>
      </div>

      <div>
        <p className="mb-1.5 text-[13px] font-medium">{W.face}</p>
        <PicturePicker
          workspaceId={workspaceId}
          value={draft.face}
          onChange={(face) => onChange({ face })}
          canUpload
          label={W.face}
          testId="chat-face-picker"
        />
        {errors.face ? <FieldError>{errors.face}</FieldError> : <Hint>{W.faceHint}</Hint>}
      </div>

      <div>
        <Label htmlFor={bubbleId}>{W.bubble}</Label>
        <Input
          id={bubbleId}
          inputSize="sm"
          value={draft.bubble}
          onChange={(e) => onChange({ bubble: e.target.value })}
          placeholder={W.bubblePlaceholder}
          maxLength={CHAT_BUBBLE_MAX}
          invalid={!!errors.bubble}
          data-testid="chat-bubble"
        />
        {errors.bubble ? (
          <FieldError>{errors.bubble}</FieldError>
        ) : (
          <Hint>{W.bubbleHint} Empty shows no bubble.</Hint>
        )}
        <div className="mt-2 flex items-center gap-2 text-[13px]">
          <label htmlFor={afterId}>{W.bubbleAfter}</label>
          <Input
            id={afterId}
            type="number"
            inputSize="sm"
            className="w-[76px]"
            min={CHAT_BUBBLE_AFTER_MIN}
            max={CHAT_BUBBLE_AFTER_MAX}
            value={draft.bubbleAfter}
            disabled={!draft.bubble.trim()}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n))
                onChange({
                  bubbleAfter: Math.max(CHAT_BUBBLE_AFTER_MIN, Math.min(CHAT_BUBBLE_AFTER_MAX, n)),
                });
            }}
            invalid={!!errors.bubbleAfter}
            data-testid="chat-bubble-after"
          />
          <span className="text-text-3">seconds on the page</span>
        </div>
        {errors.bubbleAfter ? <FieldError>{errors.bubbleAfter}</FieldError> : null}
      </div>
    </div>
  );
}
