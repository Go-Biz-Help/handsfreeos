'use client';
import { money } from '@hfos/core';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';

export interface OptionTab {
  readonly key: string;
  readonly name: string;
  readonly totalCents: number;
}

/**
 * An estimate's options while it's being written: good, better, best. One price until someone offers options;
 * then a tab each, with the open one's name to change and a way to take it off. Core's editor and an add-on's
 * builder both show this, so the options read the same wherever an estimate is written.
 */
export function OptionsBar({
  options,
  active,
  max,
  onPick,
  onAdd,
  onRename,
  onRemove,
}: {
  options: readonly OptionTab[];
  active: number;
  max: number;
  onPick: (index: number) => void;
  onAdd: () => void;
  onRename: (index: number, name: string) => void;
  onRemove: (index: number) => void;
}) {
  if (options.length === 0)
    return (
      <div
        className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-menu bg-card-2 px-3 py-2"
        data-testid="estimate-options-bar"
      >
        <span className="min-w-0 flex-1 text-[13px] text-text-2">
          One price. Offer good, better and best, and they pick one when they approve.
        </span>
        <Button variant="secondary" size="sm" onClick={onAdd} data-testid="estimate-option-add">
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          Offer options
        </Button>
      </div>
    );
  const open = options[active] ?? options[0]!;
  return (
    <div className="mb-3 flex flex-col gap-2.5" data-testid="estimate-options-bar">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          ariaLabel="Options"
          className="max-w-full overflow-x-auto"
          value={open.key}
          onChange={(key) => onPick(options.findIndex((o) => o.key === key))}
          options={options.map((o, i) => ({
            value: o.key,
            label: `${o.name.trim() || `Option ${i + 1}`} · ${money(o.totalCents)}`,
            testId: `estimate-option-tab-${i + 1}`,
          }))}
        />
        {options.length < max ? (
          <Button variant="ghost" size="sm" onClick={onAdd} data-testid="estimate-option-add">
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            Add an option
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-text-2">Called</span>
        <Input
          inputSize="sm"
          className="w-[180px] max-md:flex-1"
          value={open.name}
          maxLength={60}
          autoComplete="off"
          aria-label="What this option is called"
          onChange={(e) => onRename(active, e.target.value)}
          data-testid="estimate-option-name"
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onRemove(active)}
          data-testid="estimate-option-remove"
        >
          <Trash2 className="h-4 w-4" strokeWidth={1.5} />
          Take this option off
        </Button>
        <span className="text-[12.5px] text-text-3 max-md:w-full">
          The discount and the deposit apply to whichever they pick.
        </span>
      </div>
    </div>
  );
}
