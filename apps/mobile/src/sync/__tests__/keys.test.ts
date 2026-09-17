import { randomBytes } from 'node:crypto';

import { CopyKeys, keyName, newKey, rawKeyForm, type SecretStore } from '../keys';

function memoryStore() {
  const values = new Map<string, string>();
  const store: SecretStore = {
    get: async (name) => values.get(name) ?? null,
    set: async (name, value) => void values.set(name, value),
    delete: async (name) => void values.delete(name),
  };
  return { store, values };
}

const random = (count: number) => new Uint8Array(randomBytes(count));
const DALE = '11111111-1111-4111-8111-111111111111';

describe('a person’s key', () => {
  it('is 256 random bits, as 64 hex characters, given to SQLCipher in its raw form', () => {
    const key = newKey(random);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(newKey(random)).not.toBe(key);
    expect(rawKeyForm(key)).toBe(`x'${key}'`);
    expect(rawKeyForm(key)).toHaveLength(67);
    expect(() => newKey(() => new Uint8Array(16))).toThrow('32 random bytes');
  });

  it('is created, read back, replaced with a different one, and removed', async () => {
    const { store, values } = memoryStore();
    const keys = new CopyKeys(store, random);
    await expect(keys.read(DALE)).resolves.toBeNull();
    const first = await keys.replace(DALE);
    expect(values.get(keyName(DALE))).toBe(first);
    await expect(keys.read(DALE)).resolves.toBe(first);
    const second = await keys.replace(DALE);
    expect(second).not.toBe(first);
    await expect(keys.read(DALE)).resolves.toBe(second);
    await keys.remove(DALE);
    await expect(keys.read(DALE)).resolves.toBeNull();
    expect(values.size).toBe(0);
  });

  it('isn’t used when what’s stored isn’t a key', async () => {
    const { store, values } = memoryStore();
    values.set(keyName(DALE), 'not a key');
    await expect(new CopyKeys(store, random).read(DALE)).resolves.toBeNull();
  });

  it('is named for the person, in characters the Keychain accepts', () => {
    expect(keyName(DALE)).toBe(`hfos.copy-key.${DALE}`);
    expect(keyName(DALE)).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
