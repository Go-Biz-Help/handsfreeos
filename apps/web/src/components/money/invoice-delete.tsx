'use client';
import { BIN_WORDS } from '@hfos/core';
import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { DeleteDialog } from '@/components/bin/delete-dialog';
import { Button } from '@/components/ui/button';

/**
 * "Delete…" on an invoice (the Deleted bin, 20261027037500): owners, unless one gives it out (records.delete). The
 * box asks first: one still out for payment is voided first, and one with money on it says why it stays. Once it's
 * in the bin, back to the list.
 */
export function InvoiceDeleteButton({
  workspaceId,
  invoiceId,
  name,
  className,
}: {
  workspaceId: string;
  invoiceId: string;
  /** Its number, or its title while it's a draft. */
  name: string;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        className={className}
        onClick={() => setOpen(true)}
        data-testid="invoice-delete"
      >
        <Trash2 className="h-4 w-4" strokeWidth={1.5} />
        {BIN_WORDS.invoiceMenu}
      </Button>
      <DeleteDialog
        workspaceId={workspaceId}
        kind="invoice"
        ids={[invoiceId]}
        names={[name]}
        open={open}
        onOpenChange={setOpen}
        onDeleted={() => router.replace(`/app/w/${workspaceId}/money`)}
      />
    </>
  );
}
