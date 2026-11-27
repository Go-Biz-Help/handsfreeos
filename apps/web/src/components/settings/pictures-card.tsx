'use client';
/**
 * Settings → Workspace's "Your pictures": the business's picture library (picture-library.tsx), which the pickers on
 * forms, booking pages and emails open too.
 */
import { PICTURE_WORDS as P } from '@hfos/core';
import { PictureLibrary } from '@/components/look/picture-library';
import { Card } from '@/components/ui/card';

export function PicturesCard({
  workspaceId,
  canChange,
}: {
  workspaceId: string;
  canChange: boolean;
}) {
  return (
    <Card className="p-6" id="your-pictures" data-testid="pictures-card">
      <h2 className="text-lg font-semibold tracking-tight">{P.title}</h2>
      <p className="mb-4 mt-1 text-[13px] text-text-2">{P.hint}</p>
      <PictureLibrary workspaceId={workspaceId} canChange={canChange} />
    </Card>
  );
}
