import {
  managesAnAgency,
  searchSettings,
  SETTINGS_SEARCH_WORDS as W,
  settingPhoneTarget,
  settingValueText,
  type SettingHit,
} from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import { router, type Href } from 'expo-router';
import * as React from 'react';

import { useKeptStaff } from '@/admin/staff';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { List, ListRow } from '@/components/shell/list';
import { Text } from '@/components/ui/text';
import { useGrants } from '@/lib/grants';
import { openWeb } from '@/lib/open-web';
import { useKeepsDocuments } from '@/sync/document-keeper';

/**
 * Settings search on the phone (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Phone: Settings search", decision 12):
 * core's catalogue, searched on the phone as the person types, with no signal needed and nothing sent. A setting the
 * phone has opens in place, scrolled to and flashed (`?setting=`); one only the web changes says "Opens on the web"
 * and opens the browser at it, anchor and all, since a phone route drops what's after `#`. Values such as quiet hours
 * come from the business's synced settings.
 */
export function SettingsSearchResults({
  q,
  onFlash,
}: {
  q: string;
  /** Flashes a row of this very screen (a setting on Settings itself). */
  onFlash: (key: string) => void;
}) {
  const { business, me, userId } = useBusiness();
  const { permissions } = useGrants();
  // New support tickets and Daily agency digest are listed only to those whose Notifications show them. Whether they
  // answer support is what the phone already knows, asked for nothing, so it works with no signal.
  const staff = useKeptStaff(userId) !== null;
  const agency = managesAnAgency(me);
  // Documents on mobile data is a row only where documents are kept, as Settings shows it.
  const keepsDocuments = useKeepsDocuments(business.id);
  const { data } = useQuery<{ settings: string | null }>(
    'SELECT settings FROM workspaces WHERE id = ?',
    [business.id],
  );
  const settings = React.useMemo(() => settingsOf(data[0]?.settings), [data]);
  const hits = React.useMemo(
    () =>
      searchSettings(q, {
        permissions: permissions ?? [],
        addons: null,
        staff,
        agency,
        surface: 'phone',
      }).filter((h) => keepsDocuments || h.entry.key !== 'phone.documents_mobile_data'),
    [q, permissions, staff, agency, keepsDocuments],
  );

  const open = (hit: SettingHit) => {
    const target = settingPhoneTarget(business.id, hit.entry);
    if (target.kind === 'web') return void openWeb(target.path);
    if (target.href.startsWith(businessHref(business.id, 'settings?setting=')))
      return onFlash(hit.entry.key);
    router.push(target.href as Href);
  };

  if (hits.length === 0)
    return (
      <Text
        className="px-1 pt-2 text-[14.5px] leading-[21px] text-text-2"
        testID="settings-search-none"
      >
        {W.noMatch(q.trim())}
      </Text>
    );
  return (
    <List testID="settings-search-results">
      {hits.map((hit) => {
        const web = hit.entry.phone === 'web';
        const value = settingValueText(hit.entry.key, settings, business.timezone);
        return (
          <ListRow
            key={hit.entry.key}
            label={hit.entry.label}
            detail={[web ? W.opensOnWeb : (hit.pageLabel ?? hit.group), value]
              .filter(Boolean)
              .join(' · ')}
            external={web}
            onPress={() => open(hit)}
            testID={`settings-search-${hit.entry.key}`}
          />
        );
      })}
    </List>
  );
}

/** The business's settings, from the synced JSON text. */
function settingsOf(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
