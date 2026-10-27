import type { DeskSectionKey } from '@hfos/core';
import type { LucideIcon } from 'lucide-react-native';

import {
  Blocks,
  Bug,
  Building,
  Handshake,
  HeartPulse,
  Inbox,
  Lightbulb,
  ListChecks,
  MessageSquareQuote,
  Tag,
  Ticket,
  Users,
} from '@/components/icons';

/** The icon beside each of core's desk sections, as the web's menu has them. */
export const DESK_ICONS: Readonly<Record<DeskSectionKey, LucideIcon>> = {
  tickets: Inbox,
  ideas: Lightbulb,
  'add-ons': Blocks,
  businesses: Building,
  'getting-started': ListChecks,
  health: HeartPulse,
  problems: Bug,
  rates: Tag,
  founding: Ticket,
  affiliates: Handshake,
  replies: MessageSquareQuote,
  staff: Users,
};
