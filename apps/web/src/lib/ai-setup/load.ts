import type { ApiClient } from '@hfos/api-client';
import { unwrap, unwrapPage } from '@/lib/api/server';
import { brandedOriginFor } from '@/lib/hosting/branded-origin';
import { aiSetupGotOf, findingsOf, type AiSetupData } from './data';

/**
 * What quick setup's screens start from, for the AI teammate page and Getting started's AI step: where it stands
 * (`ai_setup.get`), what the website scan found, and for "Stay in the loop" the person's cell and phones.
 */
export async function loadAiSetup(api: ApiClient, workspaceId: string): Promise<AiSetupData> {
  const [got, scan, cell, devices, phone, brandedOrigin] = await Promise.all([
    api.POST('/v1/queries/ai_setup.get', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/knowledge_scan.get', { body: { workspaceId } }).then(unwrapPage),
    api
      .POST('/v1/queries/user_phone.get', { body: {} })
      .then(unwrap)
      .catch(() => null),
    api
      .POST('/v1/queries/push_device.list', { body: {} })
      .then(unwrap)
      .catch(() => null),
    // The business number a cell is confirmed from; someone without the inbox has none to show.
    api
      .POST('/v1/queries/phone.setup_status', { body: { workspaceId } })
      .then(unwrap)
      .catch(() => null),
    brandedOriginFor(api, workspaceId),
  ]);
  const findings = scan.scan
    ? findingsOf(
        unwrapPage(
          await api.POST('/v1/queries/knowledge_suggestion.list', {
            body: { workspaceId, scanId: scan.scan.id, status: 'pending', limit: 100 },
          }),
        ).items,
      )
    : [];
  return {
    workspaceId,
    got: aiSetupGotOf(got),
    findings,
    cell: cell?.phone ?? null,
    businessNumber: phone?.number?.status === 'active' ? phone.number.e164 : null,
    appOnPhone: (devices?.devices.length ?? 0) > 0,
    brandedOrigin,
  };
}
