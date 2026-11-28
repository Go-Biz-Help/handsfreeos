'use client';
/**
 * Settings → Workspace's "Brand kit": the business's logo and colour on its booking page, website chat, invoices and
 * the emails HandsFreeOS sends for it, as the setup's screen shows them (look-editor.tsx), then its font and corners
 * and Match my website (brand-kit.tsx). The page is drawn again as the worker finds the logo on the website or makes
 * an upload ready.
 */
import { LOOK_WORDS as L, type BusinessLook } from '@hfos/core';
import { useRouter } from 'next/navigation';
import { BrandKitExtras } from '@/components/look/brand-kit';
import { LookEditor } from '@/components/look/look-editor';
import { Card } from '@/components/ui/card';
import { useLiveRefresh } from '@/lib/realtime/live-provider';

export function LookCard({
  workspaceId,
  look,
  businessName,
  website,
  canChange,
}: {
  workspaceId: string;
  look: BusinessLook;
  businessName: string;
  website: string | null;
  canChange: boolean;
}) {
  const router = useRouter();
  useLiveRefresh(['workspace']);
  return (
    <Card className="p-6" id="logo-and-colour" data-testid="look-card">
      <h2 className="text-lg font-semibold tracking-tight">{L.settingsTitle}</h2>
      <p className="mb-4 mt-1 text-[13px] text-text-2">{L.settingsHint}</p>
      <LookEditor
        workspaceId={workspaceId}
        look={look}
        businessName={businessName}
        website={website}
        canChange={canChange}
        onChanged={() => router.refresh()}
      />
      <BrandKitExtras
        workspaceId={workspaceId}
        look={look}
        website={website}
        canChange={canChange}
        onChanged={() => router.refresh()}
      />
    </Card>
  );
}
