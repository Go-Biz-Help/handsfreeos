import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { Members } from '@/lib/api/types';

export function OrgAdmins({
  people,
  organizationName,
}: {
  people: Members['organizationAdmins'];
  organizationName: string;
}) {
  return (
    <>
      <div className="mb-3 mt-8 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">
          Also has access via {organizationName}
        </h2>
        <span className="text-[13px] text-text-3">Managed in the organization, not here</span>
      </div>
      <Card className="divide-y divide-border p-0">
        {people.map((p) => (
          <div key={p.userId} className="flex items-center gap-3 px-4 py-3">
            <Avatar name={p.fullName || p.email} seed={p.userId} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium">{p.fullName || p.email}</span>
              <span className="text-[13px] text-text-3">{p.email}</span>
            </span>
            <Badge variant={p.orgRole === 'owner' ? 'owner' : 'admin'}>
              Organization {p.orgRole === 'owner' ? 'Owner' : 'Admin'}
            </Badge>
          </div>
        ))}
      </Card>
    </>
  );
}
