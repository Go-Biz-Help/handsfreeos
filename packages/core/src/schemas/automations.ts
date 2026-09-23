/**
 * Settings → Automations' command: saving the switches and timings `workspaces.settings.automations` owns.
 * The automations whose switch lives elsewhere (Action Center kinds, AI teammate skills) save through those.
 */
import { z } from 'zod';
import { AutomationSettings } from '../automations/settings';
import { uuid } from './common';

export const AutomationsSaveSettingsInput = z.object({
  workspaceId: uuid,
  settings: AutomationSettings,
});
export const AutomationsSaveSettingsOutput = z.object({
  workspaceId: uuid,
  settings: AutomationSettings,
  changed: z.boolean(),
});
