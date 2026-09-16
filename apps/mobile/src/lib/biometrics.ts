import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';

import { config } from './config';

/**
 * Face ID or a fingerprint, as a lock on this phone only. It never touches the sign-in: the phone's own check says
 * the person holding it may open the app, nothing more (Expo's guidance, and the plan).
 */
export type UnlockMethod = 'Face ID' | 'Touch ID' | 'fingerprint' | 'face' | 'passcode';

export interface BiometricInfo {
  /** The phone has Face ID, a fingerprint or at least a passcode set up. */
  readonly available: boolean;
  readonly method: UnlockMethod;
}

export type UnlockResult = 'unlocked' | 'cancelled' | 'failed' | 'unavailable';

export interface Biometrics {
  info(): Promise<BiometricInfo>;
  authenticate(prompt: string): Promise<UnlockResult>;
}

export function methodFor(
  types: readonly LocalAuthentication.AuthenticationType[],
  os: string = Platform.OS,
): UnlockMethod {
  const face =
    types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION) ||
    types.includes(LocalAuthentication.AuthenticationType.IRIS);
  const finger = types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT);
  if (os === 'ios') return face ? 'Face ID' : finger ? 'Touch ID' : 'passcode';
  return finger ? 'fingerprint' : face ? 'face' : 'passcode';
}

/** "Unlock with Face ID", "Unlock with your fingerprint", "Unlock with your passcode". */
export function unlockLabel(method: UnlockMethod): string {
  return method === 'Face ID' || method === 'Touch ID'
    ? `Unlock with ${method}`
    : `Unlock with your ${method}`;
}

export function resultOf(result: LocalAuthentication.LocalAuthenticationResult): UnlockResult {
  if (result.success) return 'unlocked';
  switch (result.error) {
    case 'user_cancel':
    case 'system_cancel':
    case 'app_cancel':
    case 'user_fallback':
      return 'cancelled';
    case 'not_enrolled':
    case 'not_available':
    case 'passcode_not_set':
      return 'unavailable';
    default:
      return 'failed';
  }
}

const deviceBiometrics: Biometrics = {
  async info() {
    const [level, types] = await Promise.all([
      LocalAuthentication.getEnrolledLevelAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync(),
    ]);
    const biometric = level >= LocalAuthentication.SecurityLevel.BIOMETRIC_WEAK;
    return {
      available: level !== LocalAuthentication.SecurityLevel.NONE,
      method: biometric ? methodFor(types) : 'passcode',
    };
  },
  async authenticate(prompt) {
    try {
      return resultOf(
        await LocalAuthentication.authenticateAsync({
          promptMessage: prompt,
          cancelLabel: 'Cancel',
          // After a few misses the phone offers its passcode, so a wet thumb never locks anyone out.
          disableDeviceFallback: false,
          biometricsSecurityLevel: 'weak',
        }),
      );
    } catch {
      return 'failed';
    }
  },
};

// ------------------------------------------------------------------------------------ the stand-in for test builds

type Pending = (result: UnlockResult) => void;
let pending: Pending | null = null;
const pendingListeners = new Set<() => void>();

function setPending(next: Pending | null) {
  pending = next;
  for (const listener of pendingListeners) listener();
}

/**
 * Test builds (EXPO_PUBLIC_E2E=1) answer the unlock prompt from the app itself: the Android emulator has no
 * fingerprint set up, and Maestro can't press Face ID's "Matching" on the simulator. `TestUnlockPrompt` draws Match
 * and No match where the phone's own prompt would be.
 */
export const testBiometrics: Biometrics & {
  isAsking(): boolean;
  answer(result: UnlockResult): void;
  subscribe(listener: () => void): () => void;
} = {
  async info() {
    return { available: true, method: Platform.OS === 'ios' ? 'Face ID' : 'fingerprint' };
  },
  authenticate() {
    pending?.('cancelled');
    return new Promise<UnlockResult>((resolve) => setPending(resolve));
  },
  isAsking: () => pending !== null,
  answer(result) {
    const resolve = pending;
    setPending(null);
    resolve?.(result);
  },
  subscribe(listener) {
    pendingListeners.add(listener);
    return () => pendingListeners.delete(listener);
  },
};

export const biometrics: Biometrics = config.e2e ? testBiometrics : deviceBiometrics;
