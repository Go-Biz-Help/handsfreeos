import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { AdminShell } from '@/components/admin/admin-shell';
import { ThemeSync } from '@/components/shell/theme-sync';
import { apiServer, fetchMe, unwrap } from '@/lib/api/server';
import { parseTheme } from '@/lib/theme';

/**
 * HandsFreeOS's own support desk and admin side (M13). It sits in the same app as everything else, behind
 * one question asked on the server: does this person work here? Anyone else gets the 404 page, exactly as
 * they would for a business they are not in — no sign that there is anything here to find.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { api } = await apiServer();
  const me = await fetchMe(api);
  const { staff } = unwrap(await api.POST('/v1/queries/platform.me', { body: {} }));
  if (!staff) notFound();
  return (
    <>
      <ThemeSync theme={parseTheme((me.user.settings as { theme?: unknown }).theme)} />
      <AdminShell
        me={me}
        staff={{
          role: staff.role,
          displayName: staff.displayName,
          permissions: staff.permissions,
        }}
      >
        {children}
      </AdminShell>
    </>
  );
}
