/** A picture from Your pictures (core's look/pictures.ts), at Storage's public address. */
import { pictureUrlFor } from '@hfos/core';

import { config } from '@/lib/config';

export const pictureSrc = (path: string): string => pictureUrlFor(config.supabaseUrl, path);
