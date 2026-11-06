/**
 * Admin → Assistant coverage's table: the Assistant's checklist (assistant/ledger), a filtered page at a time. It reads
 * the checklist bundled with the API, compared with the screen files' fingerprints as of the deploy, so it touches no
 * table; `platform.health.read` decides who sees it, as for the rest of the coverage page.
 */
import { LEDGER_AREAS, LEDGER_FINGERPRINTS } from '../assistant/ledger/index';
import { ledgerReport } from '../assistant/ledger/report';
import { defineQuery } from '../kernel/define';
import { AssistantLedgerInput, AssistantLedgerOutput } from '../schemas/assistant-ledger';

const onPlatform = () => ({ kind: 'platform' as const });

export const platformAssistantLedger = defineQuery({
  name: 'platform.assistant_ledger',
  description:
    'Support: every item on every HandsFreeOS screen and how Ask HandsFreeOS covers it, the audit’s gaps, and the screens not checked yet, filtered by area and state, a page at a time.',
  input: AssistantLedgerInput,
  output: AssistantLedgerOutput,
  permission: 'platform.health.read',
  scope: onPlatform,
  async handler(_ctx, input) {
    return ledgerReport(LEDGER_AREAS, LEDGER_FINGERPRINTS, input);
  },
});

export const assistantLedgerQueries = [platformAssistantLedger];
