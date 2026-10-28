import { toast as sonner, type ExternalToast } from 'sonner';

/**
 * A call's own toasts, which come in from the top. Its controls and captions are along the bottom, where a toast
 * would sit over Raise hand or Leave, and stay there for as long as the pointer rests on it.
 */
const ON_TOP: ExternalToast = { position: 'top-center' };

type Message = Parameters<typeof sonner>[0];

export const toast = Object.assign(
  (message: Message, data?: ExternalToast) => sonner(message, { ...ON_TOP, ...data }),
  {
    error: (message: Message, data?: ExternalToast) =>
      sonner.error(message, { ...ON_TOP, ...data }),
  },
);
