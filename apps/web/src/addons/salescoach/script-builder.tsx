'use client';
/**
 * Building scripts the question-led way (docs/salescoach.md, "The question-led method"): the AI answers what it can
 * of the builder's questions from what HandsFreeOS knows (`salescoach.playbook.brief`), the owner fills in or fixes
 * the rest and ticks the kinds of call, and the AI writes one script for each (`salescoach.playbook.draft`). Nothing
 * is saved here: each script opens in the editor to check and save.
 */
import {
  BUILDER_KINDS,
  SALES_BRIEF_KEYS,
  SALES_BRIEF_MAX,
  SALES_BRIEF_QUESTIONS,
  type BuilderKind,
} from '@hfos/core/addons/salescoach/method';
import {
  PLAYBOOK_KIND_LABELS,
  blankBrief,
  type PlaybookDetails,
  type PlaybookDraftOutput,
  type PlaybookKind,
  type SalesBrief,
  type SalesBriefGuessOutput,
} from '@hfos/core/addons/salescoach/playbooks';
import { SALESCOACH_WORDS as W } from '@hfos/core/addons/salescoach/words';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Hint, Label } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage } from '@/lib/api/errors';
import { workerPost } from '@/lib/api/worker';

export interface BuiltScript {
  readonly name: string;
  readonly kind: PlaybookKind;
  readonly details: PlaybookDetails;
}

const action = (name: string) => `/v1/addons/salescoach/actions/${name}`;

export function ScriptBuilder({
  workspaceId,
  onBuilt,
  onCancel,
}: {
  workspaceId: string;
  onBuilt: (scripts: BuiltScript[]) => void;
  onCancel: () => void;
}) {
  const [brief, setBrief] = useState<SalesBrief>(blankBrief);
  // What the AI answered, so the questions it left blank say "Tell us".
  const [guessed, setGuessed] = useState<SalesBrief | null>(null);
  const [reading, setReading] = useState(true);
  const [kinds, setKinds] = useState<readonly BuilderKind[]>(BUILDER_KINDS);
  const [progress, setProgress] = useState<{ n: number; of: number } | null>(null);

  useEffect(() => {
    let live = true;
    workerPost<SalesBriefGuessOutput>(action('salescoach.playbook.brief'), {
      workspaceId,
      input: {},
    })
      .then((out) => {
        if (!live) return;
        setBrief(out.brief);
        setGuessed(out.brief);
      })
      .catch((e) => {
        if (live) toast.error(`${errorMessage(e)} ${W.builder.readFailed}`);
      })
      .finally(() => live && setReading(false));
    return () => {
      live = false;
    };
  }, [workspaceId]);

  const build = async () => {
    const built: BuiltScript[] = [];
    try {
      for (const [i, kind] of kinds.entries()) {
        setProgress({ n: i + 1, of: kinds.length });
        const out = await workerPost<PlaybookDraftOutput>(action('salescoach.playbook.draft'), {
          workspaceId,
          input: { kind, brief },
        });
        built.push({ name: out.name, kind, details: out.details });
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setProgress(null);
    }
    // Whatever was written before a failure is still worth checking.
    if (built.length) {
      toast.success(W.builder.built(built.length));
      onBuilt(built);
    }
  };

  const busy = reading || progress !== null;
  return (
    <Card className="space-y-4 p-4 md:p-5" data-testid="salescoach-builder">
      <div>
        <h3 className="text-[15px] font-semibold">{W.builder.title}</h3>
        <p className="mt-1 text-[13px] text-text-2">{W.builder.about}</p>
      </div>
      {reading ? (
        <p className="text-[13px] text-text-3" role="status">
          {W.builder.reading}
        </p>
      ) : (
        <>
          {guessed && SALES_BRIEF_KEYS.some((k) => guessed[k]) ? (
            <p className="text-[12.5px] text-text-3">{W.builder.fromAi}</p>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2">
            {SALES_BRIEF_KEYS.map((k) => (
              <div key={k}>
                <div className="flex items-center gap-2">
                  <Label htmlFor={`brief-${k}`}>{SALES_BRIEF_QUESTIONS[k].ask}</Label>
                  {!brief[k].trim() ? <Badge variant="pending">{W.builder.tellUs}</Badge> : null}
                </div>
                <Textarea
                  id={`brief-${k}`}
                  rows={2}
                  maxLength={SALES_BRIEF_MAX}
                  placeholder={SALES_BRIEF_QUESTIONS[k].hint}
                  value={brief[k]}
                  onChange={(e) => setBrief({ ...brief, [k]: e.target.value })}
                />
              </div>
            ))}
          </div>
          <fieldset className="space-y-2">
            <legend className="text-[13px] font-medium">{W.builder.kinds}</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {BUILDER_KINDS.map((k) => (
                <Checkbox
                  key={k}
                  label={PLAYBOOK_KIND_LABELS[k]}
                  checked={kinds.includes(k)}
                  onChange={(e) =>
                    setKinds(
                      BUILDER_KINDS.filter((x) => (x === k ? e.target.checked : kinds.includes(x))),
                    )
                  }
                />
              ))}
            </div>
            {kinds.length === 0 ? <Hint>{W.builder.noKind}</Hint> : null}
          </fieldset>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || kinds.length === 0}
          onClick={() => void build()}
          data-testid="salescoach-build"
        >
          {progress ? W.builder.building(progress.n, progress.of) : W.builder.go}
        </Button>
        <Button variant="ghost" disabled={progress !== null} onClick={onCancel}>
          {W.builder.cancel}
        </Button>
      </div>
    </Card>
  );
}
