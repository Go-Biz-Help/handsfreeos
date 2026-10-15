'use client';
/**
 * Sales Coach above the web's call bar (`call.panels`): the newest cards on the call the person is on. Drawn by
 * <AddonSlot> only while the add-on runs and for people with `salescoach.use`; with no coached call, nothing.
 */
import type { SlotProps } from '../registry';
import { LiveCoach } from './live-coach';

export default function CallPanel({ workspaceId }: SlotProps<'call.panels'>) {
  return <LiveCoach workspaceId={workspaceId} compact />;
}
