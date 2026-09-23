import { IDEAS_WORDS } from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';

import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Segmented } from '@/components/ui/segmented';

export type IdeasTab = 'ideas' | 'roadmap' | 'whats-new';

/**
 * Ideas · Roadmap · What's new, at the top of each, as the web's tabs are. Each is its own screen at the web's own
 * address (/app/w/<business>/ideas, …/ideas/roadmap, …/ideas/whats-new), so a link to any of them opens it here, and
 * moving between them replaces the one showing: Back still goes to More.
 */
export function IdeasTabs({ current }: { current: IdeasTab }) {
  const { business } = useBusiness();
  const go = (tab: IdeasTab) =>
    router.replace(businessHref(business.id, tab === 'ideas' ? 'ideas' : `ideas/${tab}`) as Href);
  return (
    <Segmented
      value={current}
      onChange={go}
      label={IDEAS_WORDS.title}
      options={[
        { value: 'ideas', label: IDEAS_WORDS.tabs.ideas, testID: 'ideas-tab-ideas' },
        { value: 'roadmap', label: IDEAS_WORDS.tabs.roadmap, testID: 'ideas-tab-roadmap' },
        { value: 'whats-new', label: IDEAS_WORDS.tabs.whatsNew, testID: 'ideas-tab-whats-new' },
      ]}
    />
  );
}
