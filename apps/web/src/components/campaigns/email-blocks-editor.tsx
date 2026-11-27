'use client';
/**
 * A campaign email in blocks (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md, part 5): words, a picture from Your
 * pictures, a button, a line and a space, top to bottom. A block moves by dragging its handle or by its arrows (for a
 * keyboard or a phone), and lines up on the left, in the centre or on the right, like a form's items.
 */
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  EMAIL_BLOCK_NAMES,
  EMAIL_BLOCK_WORDS_MAX,
  EMAIL_BLOCKS_MAX,
  EMAIL_BUTTON_LABEL_MAX,
  EMAIL_SPACE_SIZES,
  ITEM_ALIGN_LABELS,
  ITEM_ALIGNS,
  newEmailBlockId,
  PICTURE_SIZE_LABELS,
  PICTURE_SIZES,
  type EmailBlock,
  type EmailBlockKind,
  type ItemAlign,
  type PictureRef,
} from '@hfos/core';
import {
  ChevronDown,
  ChevronUp,
  GripVertical,
  Image as ImageIcon,
  Minus,
  MousePointerClick,
  MoveVertical,
  Trash2,
  Type,
} from 'lucide-react';
import { PicturePicker } from '@/components/look/picture-picker';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

type PictureBlock = Extract<EmailBlock, { kind: 'picture' }>;
/** A block as it's being written: a picture block may have no picture yet. */
export type DraftBlock =
  | Exclude<EmailBlock, PictureBlock>
  | (Omit<PictureBlock, 'picture'> & { picture: PictureRef | null });

const ICONS: Record<EmailBlockKind, typeof Type> = {
  words: Type,
  picture: ImageIcon,
  button: MousePointerClick,
  line: Minus,
  space: MoveVertical,
};
const SPACE_WORDS: Record<(typeof EMAIL_SPACE_SIZES)[number], string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
};

function newBlock(kind: EmailBlockKind, blocks: readonly DraftBlock[]): DraftBlock {
  const id = newEmailBlockId(blocks);
  switch (kind) {
    case 'words':
      return { id, kind, text: '', align: 'left' };
    case 'picture':
      return { id, kind, picture: null, size: 'full', align: 'center', words: '', link: '' };
    case 'button':
      return { id, kind, label: '', url: 'https://', align: 'left' };
    case 'line':
      return { id, kind };
    case 'space':
      return { id, kind, size: 'medium' };
  }
}

/** What's still to do before the blocks can be saved, in words; null when they're ready. */
export function blocksProblem(blocks: readonly DraftBlock[]): string | null {
  if (!blocks.length) return 'Add something to the email.';
  if (blocks.some((b) => b.kind === 'picture' && !b.picture))
    return 'Pick a picture for each picture block, or take it out.';
  if (blocks.some((b) => b.kind === 'words' && !b.text.trim()))
    return 'Write something in each block of words, or take it out.';
  if (
    blocks.some(
      (b) => b.kind === 'button' && (!b.label.trim() || !/^https?:\/\/\S+\.\S+/.test(b.url)),
    )
  )
    return 'Give each button its words and the web address it opens (starting https://).';
  if (!blocks.some((b) => b.kind === 'words' || b.kind === 'button'))
    return 'Add some words or a button: an email of only pictures often lands in spam.';
  return null;
}

export function EmailBlocksEditor({
  workspaceId,
  blocks,
  onChange,
  disabled,
}: {
  workspaceId: string;
  blocks: DraftBlock[];
  onChange: (next: DraftBlock[]) => void;
  disabled?: boolean;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const at = (id: string) => blocks.findIndex((b) => b.id === id);
  const set = (id: string, patch: Partial<DraftBlock>) =>
    onChange(blocks.map((b) => (b.id === id ? ({ ...b, ...patch } as DraftBlock) : b)));
  const move = (id: string, by: -1 | 1) => {
    const i = at(id);
    const to = i + by;
    if (to >= 0 && to < blocks.length) onChange(arrayMove(blocks, i, to));
  };
  function onDragEnd(e: DragEndEvent) {
    const from = at(String(e.active.id));
    const to = e.over ? at(String(e.over.id)) : -1;
    if (from >= 0 && to >= 0 && from !== to) onChange(arrayMove(blocks, from, to));
  }

  return (
    <div className="flex flex-col gap-2" data-testid="email-blocks">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
          {blocks.map((b, i) => (
            <BlockRow
              key={b.id}
              block={b}
              first={i === 0}
              last={i === blocks.length - 1}
              disabled={disabled}
              workspaceId={workspaceId}
              onChange={(patch) => set(b.id, patch)}
              onMove={(by) => move(b.id, by)}
              onRemove={() => onChange(blocks.filter((x) => x.id !== b.id))}
            />
          ))}
        </SortableContext>
      </DndContext>
      {blocks.length < EMAIL_BLOCKS_MAX && !disabled ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-1" data-testid="email-blocks-add">
          <span className="mr-1 text-[12.5px] text-text-3">Add</span>
          {(Object.keys(EMAIL_BLOCK_NAMES) as EmailBlockKind[]).map((kind) => {
            const Icon = ICONS[kind];
            return (
              <Button
                key={kind}
                size="sm"
                variant="secondary"
                onClick={() => onChange([...blocks, newBlock(kind, blocks)])}
                data-testid={`email-blocks-add-${kind}`}
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                {EMAIL_BLOCK_NAMES[kind]}
              </Button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function AlignPicker({
  value,
  onChange,
  disabled,
}: {
  value: ItemAlign;
  onChange: (a: ItemAlign) => void;
  disabled?: boolean;
}) {
  return (
    <Segmented
      ariaLabel="Line up"
      value={value}
      onChange={(a) => !disabled && onChange(a)}
      options={ITEM_ALIGNS.map((a) => ({
        value: a,
        label: ITEM_ALIGN_LABELS[a],
        testId: `email-block-align-${a}`,
      }))}
    />
  );
}

function BlockRow({
  block: b,
  first,
  last,
  disabled,
  workspaceId,
  onChange,
  onMove,
  onRemove,
}: {
  block: DraftBlock;
  first: boolean;
  last: boolean;
  disabled?: boolean;
  workspaceId: string;
  onChange: (patch: Partial<DraftBlock>) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const sortable = useSortable({ id: b.id, disabled });
  const Icon = ICONS[b.kind];
  const name = EMAIL_BLOCK_NAMES[b.kind];
  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={cn(
        'rounded-control border border-border bg-card p-3',
        sortable.isDragging && 'relative z-10 shadow-lg',
      )}
      data-testid="email-block"
      data-kind={b.kind}
    >
      <div className="flex items-center gap-2">
        {!disabled ? (
          <button
            type="button"
            className="-ml-1 cursor-grab touch-none rounded p-0.5 text-text-3 hover:text-text active:cursor-grabbing"
            aria-label={`Drag ${name.toLowerCase()} to move it`}
            {...sortable.attributes}
            {...sortable.listeners}
          >
            <GripVertical className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
        <Icon className="h-4 w-4 text-text-3" strokeWidth={1.75} aria-hidden />
        <span className="flex-1 text-[13px] font-medium">{name}</span>
        {!disabled ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onMove(-1)}
              disabled={first}
              aria-label={`Move ${name.toLowerCase()} up`}
              data-testid="email-block-up"
            >
              <ChevronUp className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onMove(1)}
              disabled={last}
              aria-label={`Move ${name.toLowerCase()} down`}
              data-testid="email-block-down"
            >
              <ChevronDown className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onRemove}
              aria-label={`Take out this ${name.toLowerCase()}`}
              data-testid="email-block-remove"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          </>
        ) : null}
      </div>

      {b.kind === 'words' ? (
        <div className="mt-2 flex flex-col gap-2">
          <Textarea
            value={b.text}
            onChange={(e) => onChange({ text: e.target.value })}
            maxLength={EMAIL_BLOCK_WORDS_MAX}
            disabled={disabled}
            className="min-h-[96px] text-[13.5px]"
            aria-label="Words"
            data-testid="email-block-words"
          />
          <AlignPicker
            value={b.align}
            onChange={(align) => onChange({ align })}
            disabled={disabled}
          />
        </div>
      ) : b.kind === 'picture' ? (
        <div className="mt-2 flex flex-col gap-2.5">
          <PicturePicker
            workspaceId={workspaceId}
            value={b.picture}
            onChange={(picture) => onChange({ picture })}
            disabled={disabled}
            canUpload
            label="Picture in the email"
            testId="email-block-picture"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Select
              selectSize="sm"
              value={b.size}
              disabled={disabled}
              onChange={(e) => onChange({ size: e.target.value as PictureBlock['size'] })}
              aria-label="Size"
              className="w-auto"
              data-testid="email-block-size"
            >
              {PICTURE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {PICTURE_SIZE_LABELS[s]}
                </option>
              ))}
            </Select>
            <AlignPicker
              value={b.align}
              onChange={(align) => onChange({ align })}
              disabled={disabled}
            />
          </div>
          <Input
            inputSize="sm"
            value={b.words}
            maxLength={200}
            disabled={disabled}
            onChange={(e) => onChange({ words: e.target.value })}
            placeholder="Words under it (also read out to people who can’t see it)"
            aria-label="Words under the picture"
            data-testid="email-block-caption"
          />
          <Input
            inputSize="sm"
            value={b.link}
            maxLength={500}
            disabled={disabled}
            onChange={(e) => onChange({ link: e.target.value })}
            placeholder="A web address it opens when pressed (or leave blank)"
            aria-label="Web address the picture opens"
            data-testid="email-block-link"
          />
        </div>
      ) : b.kind === 'button' ? (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              inputSize="sm"
              value={b.label}
              maxLength={EMAIL_BUTTON_LABEL_MAX}
              disabled={disabled}
              onChange={(e) => onChange({ label: e.target.value })}
              placeholder="Book now"
              aria-label="Button words"
              className="sm:w-[40%]"
              data-testid="email-block-button-label"
            />
            <Input
              inputSize="sm"
              value={b.url}
              maxLength={500}
              disabled={disabled}
              onChange={(e) => onChange({ url: e.target.value })}
              placeholder="https://"
              aria-label="Web address the button opens"
              data-testid="email-block-button-url"
            />
          </div>
          <AlignPicker
            value={b.align}
            onChange={(align) => onChange({ align })}
            disabled={disabled}
          />
        </div>
      ) : b.kind === 'space' ? (
        <div className="mt-2">
          <Segmented
            ariaLabel="Space"
            value={b.size}
            onChange={(size) => !disabled && onChange({ size })}
            options={EMAIL_SPACE_SIZES.map((s) => ({ value: s, label: SPACE_WORDS[s] }))}
          />
        </div>
      ) : null}
    </div>
  );
}
