/**
 * Home's Action Center words (M8). They live in core since M10 (`packages/core/src/attention/home-words.ts`), so the
 * phone app says exactly what the web does; these are the names the web's components have always imported.
 */
export {
  ATTENTION_KIND_LABELS as KIND_LABEL,
  attentionGroupTitle as groupTitle,
  splitItemTitle as splitTitle,
  itemCustomerOf as customerOf,
  firstNameOr as firstNameOf,
  sentenceCase as sentence,
  inSentenceCase as inSentence,
  joinAnd as andList,
  isDraftItem as isDraft,
  cardChipsOf as chipsOf,
  autoActionAt as autoAt,
  SNOOZE_MAX_DAYS,
  attentionSnoozeChoices as snoozeChoices,
  snoozedUntilWords as snoozedUntil,
  FOLD_FROM_RANK,
  FOLD_MIN,
  foldAttentionRows as foldRows,
  groupValueCents as valueOf,
  groupDaysSpan as daysSpan,
  handledByHandsFree as byHandsFree,
  handledSummary,
  attentionTargetOf as targetOf,
  LEAD_ITEM_KINDS as LEAD_KINDS,
} from '@hfos/core';
export type {
  CardChipTone as ChipTone,
  CardChipIcon as ChipIcon,
  CardChip as ShownChip,
  AttentionSnoozeChoice as SnoozeChoice,
  AttentionListRow,
  AttentionTarget as ItemTarget,
} from '@hfos/core';
import type { AttentionListRow } from '@hfos/core';
import type { AttentionItem } from '@/lib/api/types';

export type ListRow = AttentionListRow<AttentionItem>;
