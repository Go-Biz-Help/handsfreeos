/**
 * A person's phones for push notifications (M10, 0058). The app registers its Expo push token when the person signs
 * in and each time it starts, and removes it when they sign out or turn notifications off on that phone. Both are
 * for people only, both can be sent again safely, and neither waits on a phone: they run online.
 *
 * A token is live for one person at a time. Registering first releases it from anyone else who signed in on the
 * same phone (`private.release_push_token`, as the person), so a teammate's notifications never reach a phone
 * someone else is using. Rows are turned off, never deleted. Neither the token nor anything secret goes into the
 * events, the audit log or the stored answer.
 */
import { rows, sql } from '@hfos/db/client';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import {
  PushDeviceRegisterInput,
  PushDeviceRegisterOutput,
  PushDeviceRemoveInput,
  PushDeviceRemoveOutput,
} from '../schemas/push';

const account = () => ({ kind: 'account' as const });

export const pushDeviceRegister = defineCommand({
  name: 'push_device.register',
  description:
    'Get push notifications on this phone: registers its Expo push token for you, or refreshes it. Anyone else who signed in on this phone stops getting theirs here.',
  risk: 1,
  input: PushDeviceRegisterInput,
  output: PushDeviceRegisterOutput,
  permission: null,
  scope: account,
  emits: ['push_device.registered'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    await ctx.tx.execute(sql`select private.release_push_token(${input.token})`);
    // Left out, the name stays as it was; null clears it.
    const keepName = input.deviceName === undefined;
    const [row] = await rows<{ id: string; created: boolean; was_off: boolean | null }>(
      ctx.tx,
      sql`with before as (
            select d.disabled_at from app.push_devices d
            where d.user_id = ${me} and d.expo_push_token = ${input.token})
          insert into app.push_devices (user_id, platform, expo_push_token, app_version, device_name, last_seen_at)
          values (${me}, ${input.platform}, ${input.token}, ${input.appVersion}, ${input.deviceName ?? null}, now())
          on conflict on constraint push_devices_user_token_key do update set
            platform = excluded.platform,
            app_version = excluded.app_version,
            device_name = case when ${keepName} then app.push_devices.device_name else excluded.device_name end,
            last_seen_at = now(),
            disabled_at = null,
            disabled_reason = null
          returning id, (xmax = 0) as created, (select b.disabled_at is not null from before b) as was_off`,
    );
    const created = row!.created;
    // A plain refresh (every app start) is no news; a new phone, or one turned back on, is.
    if (created || row!.was_off)
      await ctx.emit({
        type: 'push_device.registered',
        entityType: 'push_device',
        entityId: row!.id,
        organizationId: null,
        workspaceId: null,
        payload: { deviceId: row!.id, platform: input.platform, turnedBackOn: !created },
        after: {
          platform: input.platform,
          appVersion: input.appVersion,
          deviceName: input.deviceName ?? null,
        },
      });
    return { deviceId: row!.id, created };
  },
});

export const pushDeviceRemove = defineCommand({
  name: 'push_device.remove',
  description:
    'Stop push notifications on one of your phones: this one when you sign out or turn them off here, or another one from your list. Already off, nothing changes.',
  risk: 1,
  input: PushDeviceRemoveInput,
  output: PushDeviceRemoveOutput,
  permission: null,
  scope: account,
  emits: ['push_device.removed'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const reason = input.reason === 'turned_off' ? 'person' : 'signed_out';
    // Only the person's own devices: their id alone, and row-level security besides. The database stamps the time.
    const [row] = await rows<{ id: string; platform: string }>(
      ctx.tx,
      sql`update app.push_devices set disabled_at = now(), disabled_reason = ${reason}
          where user_id = ${me} and disabled_at is null
            and ${input.token ? sql`expo_push_token = ${input.token}` : sql`id = ${input.deviceId!}`}
          returning id, platform::text as platform`,
    );
    if (!row) return { deviceId: null, changed: false };
    await ctx.emit({
      type: 'push_device.removed',
      entityType: 'push_device',
      entityId: row.id,
      organizationId: null,
      workspaceId: null,
      payload: { deviceId: row.id, platform: row.platform, reason: input.reason },
      after: { reason: input.reason },
    });
    return { deviceId: row.id, changed: true };
  },
});
