'use client';
import { MENU_WORDS, menuSummary } from '@hfos/core';
import { SlidersHorizontal } from 'lucide-react';
import { useMenu } from '@/components/shell/menu-provider';
import { Button } from '@/components/ui/button';

/**
 * Settings → Account: what the side menu holds now, and the way in to arrange it. The only way in — the menu
 * itself is places to go, and a row for editing it would be read past every day for something done once.
 */
export function MenuSection() {
  const { menu, openEditor } = useMenu();
  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">{MENU_WORDS.sectionTitle}</h2>
      <p className="mt-1 text-[13px] text-text-2">{MENU_WORDS.intro}</p>
      <p className="mt-3 text-[13px] font-medium text-text-2" data-testid="menu-summary">
        {menuSummary(menu)}
      </p>
      <Button
        variant="secondary"
        size="sm"
        className="mt-3"
        data-testid="settings-edit-menu"
        onClick={openEditor}
      >
        <SlidersHorizontal className="h-4 w-4" strokeWidth={1.75} />
        {MENU_WORDS.edit}
      </Button>
    </div>
  );
}
