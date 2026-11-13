/**
 * The microphone, camera and speaker someone picked, remembered on this device for their next call
 * (docs/video-calls.md): picked before joining (./pre-join.tsx) or during the call (./mic.tsx's menu).
 */
import type { DeviceChoices } from './types';

const REMEMBERED = 'hfos.call.devices';

/** What they picked last time, or everything on when nothing was kept. */
export function rememberedDevices(): DeviceChoices {
  try {
    const kept = JSON.parse(localStorage.getItem(REMEMBERED) ?? 'null') as Partial<DeviceChoices>;
    if (kept && typeof kept === 'object')
      return {
        mic: kept.mic !== false,
        camera: kept.camera !== false,
        blur: kept.blur === true,
        ...(typeof kept.audioDeviceId === 'string' ? { audioDeviceId: kept.audioDeviceId } : {}),
        ...(typeof kept.videoDeviceId === 'string' ? { videoDeviceId: kept.videoDeviceId } : {}),
        ...(typeof kept.audioOutputId === 'string' ? { audioOutputId: kept.audioOutputId } : {}),
      };
  } catch {
    // Storage is off (a private window): start with everything on.
  }
  return { mic: true, camera: true, blur: false };
}

/** Keeps what they picked; a trouble from this time (`micTrouble`) is never kept. */
export function rememberDevices(c: DeviceChoices) {
  try {
    const { micTrouble: _trouble, ...kept } = c;
    localStorage.setItem(REMEMBERED, JSON.stringify(kept));
  } catch {
    // Nothing kept; they pick again next time.
  }
}

/** One device picked during the call, kept beside the rest. */
export function rememberDevice(
  kind: 'audioDeviceId' | 'videoDeviceId' | 'audioOutputId',
  id: string,
) {
  rememberDevices({ ...rememberedDevices(), [kind]: id });
}
