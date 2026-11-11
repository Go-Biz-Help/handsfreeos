'use client';
/**
 * On core's estimate page, for an estimate the builder wrote: each option's profit and margin, whether it's waiting
 * for an OK, and the way into the builder. Drawn by <AddonSlot> only while the add-on runs, and only for people who
 * may see job costs: nobody else gets the figures, here or from the API.
 */
import { CONTRACTOR_WORDS } from '@hfos/core/addons/contractor/words';
import { Calculator } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { SlotProps } from '../registry';
import { contractorHref } from './bits';
import { CheckNote, CostingRows, OptionMargins } from './costing';
import type { EstimateBuilderData } from './types';

const P = CONTRACTOR_WORDS.panels;

export default function EstimatePanel({
  workspaceId,
  estimateId,
  status,
  builtBy,
}: SlotProps<'estimate.panels'>) {
  const [data, setData] = useState<EstimateBuilderData | null>(null);
  const ours = builtBy === 'contractor';
  useEffect(() => {
    if (!ours) return;
    let on = true;
    apiBrowser()
      .POST('/v1/queries/contractor.estimate.get', { body: { workspaceId, estimateId } })
      .then((r) => on && setData(unwrap(r)))
      // Someone who may not see it gets no panel, which is the whole answer.
      .catch(() => on && setData(null));
    return () => {
      on = false;
    };
  }, [ours, workspaceId, estimateId, status]);
  if (!ours || !data?.check) return null;
  const { check } = data;
  const options = check.options.map((o) => ({ name: o.name, costing: o }));
  const picked =
    options.find((o) => o.name !== null && o.name === data.estimate?.optionName) ?? options[0];
  const draft = status === 'draft';
  return (
    <Card className="mb-4 p-4 md:p-5" data-testid="contractor-estimate-panel">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold">
          <Calculator className="h-4 w-4 text-accent-text" strokeWidth={1.75} />
          {P.estimateTitle}
          {picked?.name ? `: “${picked.name}”` : ''}
        </h3>
        <ButtonLink
          href={contractorHref(workspaceId, `estimates/${estimateId}`)}
          size="sm"
          variant={draft ? 'primary' : 'secondary'}
          data-testid="estimate-open-builder"
        >
          {P.openBuilder}
        </ButtonLink>
      </div>
      {draft ? <p className="mb-1.5 text-[12.5px] text-text-3">{P.estimateHint}</p> : null}
      {picked ? <CostingRows costing={picked.costing} minBp={check.minMarginBp} /> : null}
      <OptionMargins options={options} minBp={check.minMarginBp} />
      {draft && !check.ok ? <CheckNote check={check} options={options.length} /> : null}
    </Card>
  );
}
