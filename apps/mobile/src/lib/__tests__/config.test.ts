import { easProjectIdOf, WORKER_URL, workerUrlOf } from '../config';

describe('where a build points', () => {
  it('takes the worker’s address from the build when it has one', () => {
    expect(workerUrlOf('https://hooks.example.com', false)).toBe('https://hooks.example.com');
    expect(workerUrlOf('http://localhost:4100', true)).toBe('http://localhost:4100');
  });

  it('drops the trailing slashes, so one path doesn’t become a double slash', () => {
    expect(workerUrlOf('https://hooks.example.com//', false)).toBe('https://hooks.example.com');
  });

  // A release build made without EXPO_PUBLIC_WORKER_URL used to have no Assistant at all: every question answered
  // with "The Assistant can’t be reached from this app", and nothing on the phone able to put it right.
  it('falls back to the live worker in a release build, rather than shipping without an Assistant', () => {
    expect(workerUrlOf(undefined, false)).toBe(WORKER_URL);
    expect(workerUrlOf('', false)).toBe(WORKER_URL);
    expect(workerUrlOf('   ', false)).toBe(WORKER_URL);
  });

  // Falling back on a Mac would point a local app at the live worker, which acts on a real business.
  it('leaves a development build without one, so it can’t reach the live worker by accident', () => {
    expect(workerUrlOf(undefined, true)).toBe('');
    expect(workerUrlOf('', true)).toBe('');
  });

  it('reads the Expo project id from app.json’s extra, and says when there isn’t one', () => {
    expect(easProjectIdOf({ eas: { projectId: ' abc-123 ' } })).toBe('abc-123');
    expect(easProjectIdOf({ eas: { projectId: '' } })).toBeNull();
    expect(easProjectIdOf({})).toBeNull();
    expect(easProjectIdOf(undefined)).toBeNull();
  });
});
