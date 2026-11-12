'use client';
/**
 * Sales Coach above the web's call bar, and over a HandsFreeOS video call's video (`call.panels`, `framed` by the
 * call's box): the newest cards on the call the person is on. Drawn by <AddonSlot> only while the add-on runs and for
 * people with `salescoach.use`; with no coached call, nothing.
 */
import type { SlotProps } from '../registry';
import { LiveCoach } from './live-coach';

export default function CallPanel({ workspaceId, framed }: SlotProps<'call.panels'>) {
  return <LiveCoach workspaceId={workspaceId} compact framed={framed} />;
}
