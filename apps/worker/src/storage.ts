import { createClient } from '@supabase/supabase-js';

/**
 * The worker's access to Supabase Storage with its own key. Every caller asserts the object path
 * lies inside the job's workspace prefix before touching an object (see handlers/file-removed.ts).
 */
export interface ObjectStore {
  /** Removes an object; a missing object is not an error (handlers are at-least-once). */
  remove(bucket: string, path: string): Promise<void>;
  download(bucket: string, path: string): Promise<Buffer>;
  exists(bucket: string, path: string): Promise<boolean>;
}

export function createSupabaseStore(url: string, secretKey: string): ObjectStore {
  const client = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async remove(bucket, path) {
      const { error } = await client.storage.from(bucket).remove([path]);
      if (error && !/not found/i.test(error.message))
        throw new Error(`storage remove failed: ${error.message}`);
    },
    async download(bucket, path) {
      const { data, error } = await client.storage.from(bucket).download(path);
      if (error || !data)
        throw new Error(`storage download failed: ${error?.message ?? 'no data'}`);
      return Buffer.from(await data.arrayBuffer());
    },
    async exists(bucket, path) {
      const dir = path.split('/').slice(0, -1).join('/');
      const name = path.split('/').pop()!;
      const { data, error } = await client.storage
        .from(bucket)
        .list(dir, { search: name, limit: 100 });
      if (error) throw new Error(`storage list failed: ${error.message}`);
      return (data ?? []).some((o) => o.name === name);
    },
  };
}

/** Used when SUPABASE_URL / SUPABASE_SECRET_KEY are not set: storage jobs fail loudly and retry. */
export const unconfiguredStore: ObjectStore = {
  remove: async () => {
    throw new Error(
      'Storage is not configured: set SUPABASE_URL and SUPABASE_SECRET_KEY for the worker',
    );
  },
  download: async () => {
    throw new Error(
      'Storage is not configured: set SUPABASE_URL and SUPABASE_SECRET_KEY for the worker',
    );
  },
  exists: async () => {
    throw new Error(
      'Storage is not configured: set SUPABASE_URL and SUPABASE_SECRET_KEY for the worker',
    );
  },
};
