'use client';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { NewFormDialog } from './new-form';

export function NewFormButton({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="form-new">
        <Plus className="h-4 w-4" strokeWidth={1.75} />
        New form
      </Button>
      <NewFormDialog workspaceId={workspaceId} open={open} onOpenChange={setOpen} />
    </>
  );
}
