import { plainSpaces } from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';
import { View } from 'react-native';

import { useBusiness } from '@/components/shell/business-context';
import { List, ListLabel, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { isKept, useKeepChoices } from '@/lib/businesses';
import { testToolsEnabled } from '@/lib/config';
import { isTestOffline, setTestOffline } from '@/lib/network';
import { asOfText, lineText, useSyncStatus } from '@/lib/sync-status';
import { phoneCopy } from '@/sync';
import { AppSchema } from '@/sync/app-schema';
import { deviceFiles } from '@/sync/device-files';
import { peopleWithCopies } from '@/sync/files';
import { businessCopyOf, usePhoneCopy } from '@/sync/hooks';
import { copyLogger } from '@/sync/logger';
import { ageCopy, compareKeyForms, openWithoutKey } from '@/sync/test-tools';

/**
 * Test builds only: what this phone keeps for the signed-in person, read straight from their copy. Each business with
 * a subscription (kept, or open without being kept), how many rows of each table it has here, the last sync, the
 * SQLCipher version, the key's form and how long the copy took to open; and buttons to disconnect, to make the last
 * sync 31 days old, to try the file without its key and to time both key forms. The Maestro flows read it.
 */
export default function PhoneCopyScreen() {
  const { business, me, userId } = useBusiness();
  const copy = usePhoneCopy();
  const status = useSyncStatus();
  const choices = useKeepChoices(userId);
  const [result, setResult] = React.useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  // The same test switch as in Settings, reachable here while the copy is locked.
  const [noSignal, setNoSignal] = React.useState(isTestOffline());
  if (!testToolsEnabled || copy.state.status !== 'open') return null;
  const { report } = copy.state;
  const sync = copy.sync;

  // The person's other businesses too, kept or not, with whatever of each is on the phone.
  const otherBusinesses = me.businesses.filter((b) => b.id !== business.id);
  const others = peopleWithCopies(deviceFiles).filter((id) => id !== userId);

  const act = (id: string, work: () => Promise<string | void>) => {
    setBusy(id);
    setResult(null);
    void work()
      .then((text) => text && setResult({ id, text }))
      .catch((error: unknown) =>
        setResult({ id, text: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => setBusy(null));
  };

  return (
    <Screen title="This phone’s copy" leading="close" testID="phone-copy">
      <ListLabel>This phone</ListLabel>
      <List>
        <ListRow
          label="Status"
          end={<Value id="copy-status">{lineText(status, Date.now())}</Value>}
        />
        <ListRow
          label="Last sync"
          detail={sync?.lastSyncedAt?.toISOString()}
          end={
            <Value id="copy-last-sync">
              {sync?.lastSyncedAt
                ? asOfText(sync.lastSyncedAt.getTime(), Date.now()).replace('As of ', '')
                : 'Never'}
            </Value>
          }
        />
        <ListRow
          label="Connection"
          end={
            <Value id="copy-connection">
              {copy.heldOffline
                ? 'Disconnected here'
                : sync?.connected
                  ? 'Connected'
                  : sync?.connecting
                    ? 'Connecting'
                    : 'Not connected'}
            </Value>
          }
        />
        <ListRow label="SQLCipher" end={<Value id="copy-cipher">{report.cipherVersion}</Value>} />
        <ListRow
          label="Key"
          detail="In the Keychain or Keystore, this device only"
          end={
            <Value id="copy-key-form">
              {report.keyForm === 'raw' ? 'Raw 256-bit' : 'Passphrase'}
            </Value>
          }
        />
        <ListRow label="Opened in" end={<Value id="copy-open-ms">{`${report.openMs} ms`}</Value>} />
        <ListRow
          label="When you signed in"
          detail={
            report.othersDeleted > 0
              ? `Deleted ${report.othersDeleted === 1 ? 'another person’s copy' : `${report.othersDeleted} other people’s copies`} and replaced their keys`
              : 'No one else’s copy was here'
          }
          end={<Value id="copy-signed-in">{report.newKey ? 'New key' : 'Same key'}</Value>}
        />
        <ListRow
          label="Other people’s copies"
          end={
            <Value id="copy-others">{others.length === 0 ? 'None' : String(others.length)}</Value>
          }
        />
      </List>

      <BusinessRows
        businessId={business.id}
        name={business.name}
        slot="open"
        kept={isKept(choices, business.id)}
        part="summary"
      />

      <ListLabel>Tools</ListLabel>
      <List>
        <ListRow
          label="No signal"
          detail="The same test switch as in Settings"
          end={
            <Switch
              label="No signal"
              testID="copy-no-signal"
              checked={noSignal}
              onCheckedChange={(next) => {
                setTestOffline(next);
                setNoSignal(next);
              }}
            />
          }
        />
      </List>
      <View className="gap-2">
        <Button
          variant="secondary"
          loading={busy === 'connection'}
          onPress={() =>
            act('connection', () => phoneCopy.holdOffline(!copy.heldOffline).then(() => undefined))
          }
          testID={copy.heldOffline ? 'copy-connect' : 'copy-disconnect'}
        >
          {copy.heldOffline ? 'Connect' : 'Disconnect'}
        </Button>
        <Button
          variant="secondary"
          loading={busy === 'age'}
          onPress={() =>
            act('age', () =>
              ageCopy(31).then(
                () => 'The last sync is now 31 days old, and the phone is disconnected.',
              ),
            )
          }
          testID="copy-age"
        >
          Make the last sync 31 days old
        </Button>
        <Button
          variant="secondary"
          loading={busy === 'without-key'}
          onPress={() => act('without-key', () => openWithoutKey(userId))}
          testID="copy-try-without-key"
        >
          Try opening it without the key
        </Button>
        <Button
          variant="secondary"
          loading={busy === 'compare'}
          onPress={() =>
            act('compare', async () => {
              const { raw, passphrase } = await compareKeyForms();
              return `Raw key: a connection ${raw.connectionMs} ms, PowerSync ${raw.powerSyncMs} ms. Passphrase: a connection ${passphrase.connectionMs} ms, PowerSync ${passphrase.powerSyncMs} ms.`;
            })
          }
          testID="copy-compare-keys"
        >
          Compare key forms
        </Button>
        {result ? (
          <Text
            className="px-1 text-[13px] leading-[19px] text-text-2"
            testID={`copy-result-${result.id}`}
          >
            {result.text}
          </Text>
        ) : null}
      </View>

      <BusinessRows
        businessId={business.id}
        name={business.name}
        slot="open"
        kept={isKept(choices, business.id)}
        part="tables"
      />
      {otherBusinesses.map((b) => (
        <BusinessRows
          key={b.id}
          businessId={b.id}
          name={b.name}
          slot={b.id}
          kept={isKept(choices, b.id)}
          part="all"
        />
      ))}

      {copyLogger.recent().length > 0 ? (
        <>
          <ListLabel>Recent problems</ListLabel>
          <View className="gap-1 px-1">
            {copyLogger.recent().map((line, i) => (
              <Text key={i} className="font-mono text-[11px] leading-4 text-text-3">
                {line}
              </Text>
            ))}
          </View>
        </>
      ) : null}
    </Screen>
  );
}

/** A value at the end of a row, with its own test id so a flow can read it. */
function Value({ id, children }: { id: string; children: string }) {
  return (
    <Text className="text-sm text-text-3" testID={id}>
      {children}
    </Text>
  );
}

/** Tables with a business's rows; `workspaces` is the business itself. */
const PER_BUSINESS = AppSchema.tables
  .filter((t) => t.columns.some((c) => c.name === 'workspace_id'))
  .map((t) => t.name)
  .sort();

const COUNTS = [
  "SELECT 'workspaces' AS name, count(*) AS n FROM workspaces WHERE id = ?1",
  ...PER_BUSINESS.map((t) => `SELECT '${t}', count(*) FROM ${t} WHERE workspace_id = ?1`),
].join(' UNION ALL ');

function BusinessRows({
  businessId,
  name,
  slot,
  kept,
  part,
}: {
  businessId: string;
  name: string;
  /** "open" for the business on screen, so a flow can find it; its id otherwise. */
  slot: string;
  kept: boolean;
  /** Its summary (kept, complete, rows, every count on a line), its rows per table, or both. */
  part: 'summary' | 'tables' | 'all';
}) {
  const { sync } = usePhoneCopy();
  const copy = businessCopyOf(sync, businessId, Date.now());
  const { data } = useQuery<{ name: string; n: number }>(COUNTS, [businessId]);
  const rows = data.filter((r) => r.n > 0);
  const total = data.reduce((sum, r) => sum + r.n, 0);
  // PowerSync's status gives an invalid expiry (see readBusinessSubscriptions), so read its table.
  const { data: subscription } = useQuery<{ expires_at: number | null }>(
    `SELECT expires_at FROM ps_stream_subscriptions WHERE stream_name = 'business_v1' AND local_params = ?`,
    [JSON.stringify({ workspace_id: businessId })],
  );
  const expiresAt = subscription[0]?.expires_at;
  const expires = typeof expiresAt === 'number' ? new Date(expiresAt / 1000) : null;
  const summary = part !== 'tables';
  const tables = part !== 'summary';
  return (
    <>
      <ListLabel>{part === 'tables' ? `${name}: rows per table` : name}</ListLabel>
      {summary ? (
        <>
          <List testID={`copy-business-${slot}`}>
            <ListRow
              label={kept ? 'Kept on this phone' : 'Not kept'}
              detail={
                expires
                  ? `Subscription runs out ${plainSpaces(expires.toLocaleString('en-US'))} unless renewed`
                  : undefined
              }
              end={
                <Value id={`copy-${slot}-complete`}>
                  {copy.complete
                    ? 'Complete'
                    : copy.percent === null
                      ? 'Not yet'
                      : `${copy.percent}%`}
                </Value>
              }
            />
            <ListRow label="Rows" end={<Value id={`copy-${slot}-total`}>{String(total)}</Value>} />
          </List>
          {/* Every table's count on one line, for a flow to read at once. */}
          <Text
            className="px-1 font-mono text-[11px] leading-4 text-text-3"
            testID={`copy-${slot}-counts`}
          >
            {data.map((r) => `${r.name}=${r.n}`).join(' ')}
          </Text>
        </>
      ) : null}
      {tables && rows.length > 0 ? (
        <List>
          {rows.map((r) => (
            <ListRow
              key={r.name}
              label={r.name}
              end={<Value id={`copy-${slot}-${r.name}`}>{String(r.n)}</Value>}
            />
          ))}
        </List>
      ) : null}
    </>
  );
}
