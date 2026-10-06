import type { ApiClient } from '@hfos/api-client';
import {
  aiSetupFindingsOf,
  can,
  ONBOARDING_SETUP_SCREENS,
  onboardingSetupOpenAt,
  onboardingSetupStateOf,
  type OnboardingSetupScreen,
} from '@hfos/core';
import { loadMigrations, setupMoveOf } from '@/lib/agency/migrations';
import { unwrap, unwrapPage } from '@/lib/api/server';
import { brandedOriginFor } from '@/lib/hosting/branded-origin';
import { loadTexting } from '@/lib/texting';
import { onboardingSetupGotOf, type OnboardingSetupData } from './data';

/**
 * What the onboarding setup's screens start from (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §7): where
 * it stands (`onboarding_setup.get`), what the website scan found, and for "Stay in the loop" the person's cell and
 * phones. The screen it opens on, and the one asked for (`at`: the screens ask for theirs as they move on), also get
 * what their own screen needs: Settings → Texting & calls for the number, and GoHighLevel's move for the customers.
 */
export async function loadOnboardingSetup(
  api: ApiClient,
  ws: {
    readonly id: string;
    readonly organizationId: string;
    readonly permissions: readonly string[];
  },
  at: string | null,
): Promise<OnboardingSetupData> {
  const workspaceId = ws.id;
  const [raw, scan, cell, devices, phone, brandedOrigin] = await Promise.all([
    api.POST('/v1/queries/onboarding_setup.get', { body: { workspaceId } }).then(unwrapPage),
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
  const got = onboardingSetupGotOf(raw);
  const screen = onboardingSetupOpenAt({ ...got, state: onboardingSetupStateOf(got.state) }, at);
  const asked = ONBOARDING_SETUP_SCREENS.find((s) => s === at);
  const wants = (s: OnboardingSetupScreen) => screen === s || asked === s;
  const canMigrate = can(ws.permissions, 'migrations.manage');
  const [findings, texting, move] = await Promise.all([
    scan.scan
      ? api
          .POST('/v1/queries/knowledge_suggestion.list', {
            body: { workspaceId, scanId: scan.scan.id, status: 'pending', limit: 100 },
          })
          .then((r) => aiSetupFindingsOf(unwrapPage(r).items))
      : [],
    wants('number') ? loadTexting(api, workspaceId) : undefined,
    wants('customers') && canMigrate
      ? loadMigrations(api, ws.organizationId, workspaceId).then(setupMoveOf)
      : undefined,
  ]);
  return {
    workspaceId,
    organizationId: ws.organizationId,
    got,
    findings,
    cell: cell?.phone ?? null,
    businessNumber: phone?.number?.status === 'active' ? phone.number.e164 : null,
    appOnPhone: (devices?.devices.length ?? 0) > 0,
    brandedOrigin,
    at: screen,
    resumed: !asked && !!got.reached && !got.finished,
    ...(wants('number') ? { texting: texting ?? null } : {}),
    ...(wants('customers')
      ? {
          customers: {
            connection: move?.connection ?? null,
            move: move?.move ?? null,
            canImport: can(ws.permissions, 'records.import'),
            canMigrate,
          },
        }
      : {}),
  };
}
