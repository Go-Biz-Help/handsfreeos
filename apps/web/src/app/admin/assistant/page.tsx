import { DESK_COVERAGE_WORDS, deskSectionsFor } from '@hfos/core';
import { AssistantCoverage } from '@/components/admin/assistant-coverage';
import { apiServer, unwrap } from '@/lib/api/server';

/**
 * What Ask HandsFreeOS can't do yet, and Copy gaps for Claude. It's read from the code, not asked of the API, so the
 * page checks the support role itself, as the menu does.
 */
export default async function AssistantCoveragePage() {
  const { api } = await apiServer();
  const { staff } = unwrap(await api.POST('/v1/queries/platform.me', { body: {} }));
  if (!deskSectionsFor(staff?.permissions ?? []).some((s) => s.key === 'assistant'))
    return (
      <p
        className="mx-auto w-full max-w-5xl text-[13px] text-text-3"
        data-testid="coverage-not-yours"
      >
        {DESK_COVERAGE_WORDS.notYours}
      </p>
    );
  return <AssistantCoverage />;
}
