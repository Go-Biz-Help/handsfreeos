import {
  Bike,
  Box,
  Briefcase,
  Building2,
  Car,
  FileText,
  GraduationCap,
  Heart,
  House,
  KeyRound,
  PawPrint,
  Plug,
  Sailboat,
  Trees,
  Truck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { recordIconOf, type RecordIcon as RecordIconKey } from '@hfos/core';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

/** The picture for each of core's RECORD_ICONS. */
export const RECORD_ICON_COMPONENTS: Readonly<Record<RecordIconKey, LucideIcon>> = {
  box: Box,
  paw: PawPrint,
  car: Car,
  truck: Truck,
  bike: Bike,
  boat: Sailboat,
  home: House,
  building: Building2,
  key: KeyRound,
  student: GraduationCap,
  wrench: Wrench,
  plug: Plug,
  tree: Trees,
  heart: Heart,
  briefcase: Briefcase,
  file: FileText,
};

/** A kind of record's picture on its tinted tile, the way a company wears its building. */
export function RecordIcon({
  icon,
  size = 'sm',
  className,
}: {
  icon: string | null | undefined;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const Icon = RECORD_ICON_COMPONENTS[recordIconOf(icon)];
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex flex-none items-center justify-center bg-card-3 text-text',
        size === 'sm'
          ? 'h-6 w-6 rounded-[6px]'
          : size === 'md'
            ? 'h-8 w-8 rounded-[8px]'
            : 'h-12 w-12 rounded-card md:h-14 md:w-14',
        className,
      )}
    >
      <Icon
        className={size === 'lg' ? 'h-6 w-6' : size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5'}
        strokeWidth={1.5}
      />
    </span>
  );
}

/** Whatever a relationship's other end is: a person's avatar, a company's building, a record's picture. */
export function RelatedMark({
  kind,
  id,
  name,
  icon,
}: {
  kind: 'person' | 'company' | 'custom_record';
  id: string;
  name: string;
  icon?: string | null;
}) {
  if (kind === 'person') return <Avatar name={name} seed={id} size="sm" />;
  return <RecordIcon icon={kind === 'company' ? 'building' : icon} />;
}

/** Where a related record's own page is. */
export function relatedHref(
  workspaceId: string,
  kind: 'person' | 'company' | 'custom_record',
  id: string,
): string {
  const base = `/app/w/${workspaceId}/customers`;
  return kind === 'person'
    ? `${base}/people/${id}`
    : kind === 'company'
      ? `${base}/companies/${id}`
      : `${base}/records/${id}`;
}
