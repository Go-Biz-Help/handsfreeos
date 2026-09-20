/** Who sees which threads (M17). One switch, and what it moved. */
import { z } from 'zod';
import { uuid } from './common';

export const InboxSetVisibilityInput = z.object({
  workspaceId: uuid,
  /** True: each person sees their own threads. False (the default): everyone sees everything. */
  perPerson: z.boolean(),
});

export const InboxSetVisibilityOutput = z.object({
  perPerson: z.boolean(),
  /** How many threads were repainted, so the screen can say what just happened rather than only that it did. */
  conversationsChanged: z.number().int().nonnegative(),
});
