import { createDeviceStore } from '../device-store';

describe('the device store', () => {
  it('reads once, writes every change, and tells listeners', () => {
    let text: string | null = JSON.stringify({ appearance: 'dark' });
    const read = jest.fn(() => text);
    const store = createDeviceStore({ read, write: (t) => void (text = t) });
    const heard = jest.fn();
    store.subscribe(heard);
    expect(store.get('appearance')).toBe('dark');
    store.set('person.a.keep', { ls: true });
    store.remove('appearance');
    store.remove('never-set');
    expect(read).toHaveBeenCalledTimes(1);
    expect(JSON.parse(text!)).toEqual({ 'person.a.keep': { ls: true } });
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('starts again from a damaged file', () => {
    const store = createDeviceStore({ read: () => '{not json', write: () => undefined });
    expect(store.get('anything')).toBeUndefined();
  });
});
