'use client';
import { BIN_WORDS } from '@hfos/core';
import { Trash2 } from 'lucide-react';
import { useWorkspaceShell } from '@/components/shell/workspace-shell';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/**
 * A customer deleted for good, opened from an old link (the Deleted bin, 20261027000400): where they went, in the
 * API's words, with the way to the bin for whoever may bring them back. Drawn like the shell's MissingPage.
 */
export function RecordGone({ message, canOpenBin }: { message: string; canOpenBin: boolean }) {
  const { workspaceId } = useWorkspaceShell();
  return (
    <div className="mx-auto max-w-[480px] py-8 md:py-14" data-testid="record-gone">
      <Card className="rounded-dialog p-7 text-center md:p-9">
        <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-card-2 text-text-2">
          <Trash2 className="h-5 w-5" strokeWidth={1.5} />
        </div>
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{BIN_WORDS.goneTitle}</h1>
        <p className="mt-2 text-text-2">{message}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {canOpenBin ? (
            <ButtonLink href={`/app/w/${workspaceId}/settings/deleted-bin`} variant="primary">
              {BIN_WORDS.openBin}
            </ButtonLink>
          ) : null}
          <ButtonLink
            href={`/app/w/${workspaceId}/customers`}
            variant={canOpenBin ? 'secondary' : 'primary'}
          >
            Go to Contacts
          </ButtonLink>
        </div>
      </Card>
    </div>
  );
}
