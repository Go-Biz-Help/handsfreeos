'use client';
import { formatPhone } from '@hfos/core';
import { Button, ButtonLink } from '@/components/ui/button';
import type { Match } from '@/lib/api/types';
import { Callout } from './chips';

const ON: Record<Match['matchedOn'], string> = {
  email: 'email address',
  phone: 'phone number',
  name: 'name',
};

export function DuplicateWarning({
  workspaceId,
  kind,
  matches,
  onSaveAnyway,
  saving,
}: {
  workspaceId: string;
  kind: 'person' | 'company';
  matches: Match[];
  onSaveAnyway?: () => void;
  saving?: boolean;
}) {
  const first = matches[0];
  if (!first) return null;
  const href = `/app/w/${workspaceId}/customers/${kind === 'person' ? 'people' : 'companies'}/${first.id}`;
  return (
    <Callout className="mb-3.5" data-testid="duplicate-warning">
      <div className="flex flex-col gap-2">
        <span>
          <strong>Looks like {first.name} already exists</strong> with this {ON[first.matchedOn]}
          {first.phone ? ` (${formatPhone(first.phone)})` : first.email ? ` (${first.email})` : ''}.
          {matches.length > 1 ? ` ${matches.length - 1} more match.` : ''}
        </span>
        <span className="flex flex-wrap gap-2">
          <ButtonLink href={href} variant="secondary" size="sm">
            Open {first.name}
          </ButtonLink>
          {onSaveAnyway ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onSaveAnyway}
              loading={saving}
              data-testid="save-anyway"
            >
              Save anyway
            </Button>
          ) : null}
        </span>
      </div>
    </Callout>
  );
}
