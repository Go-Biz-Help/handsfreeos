import { AuthenticationType } from 'expo-local-authentication';

import { methodFor, resultOf, testBiometrics, unlockLabel } from '../biometrics';

describe('Face ID and fingerprints', () => {
  it('names the phone’s own way in', () => {
    expect(methodFor([AuthenticationType.FACIAL_RECOGNITION], 'ios')).toBe('Face ID');
    expect(methodFor([AuthenticationType.FINGERPRINT], 'ios')).toBe('Touch ID');
    expect(methodFor([], 'ios')).toBe('passcode');
    expect(
      methodFor([AuthenticationType.FINGERPRINT, AuthenticationType.FACIAL_RECOGNITION], 'android'),
    ).toBe('fingerprint');
    expect(methodFor([AuthenticationType.FACIAL_RECOGNITION], 'android')).toBe('face');
    expect(unlockLabel('Face ID')).toBe('Unlock with Face ID');
    expect(unlockLabel('fingerprint')).toBe('Unlock with your fingerprint');
  });

  it('tells a cancel from a miss', () => {
    expect(resultOf({ success: true })).toBe('unlocked');
    expect(resultOf({ success: false, error: 'user_cancel' })).toBe('cancelled');
    expect(resultOf({ success: false, error: 'authentication_failed' })).toBe('failed');
    expect(resultOf({ success: false, error: 'lockout' })).toBe('failed');
    expect(resultOf({ success: false, error: 'passcode_not_set' })).toBe('unavailable');
  });

  it('lets test builds answer the prompt', async () => {
    const first = testBiometrics.authenticate('Unlock');
    expect(testBiometrics.isAsking()).toBe(true);
    testBiometrics.answer('unlocked');
    await expect(first).resolves.toBe('unlocked');
    expect(testBiometrics.isAsking()).toBe(false);
  });
});
