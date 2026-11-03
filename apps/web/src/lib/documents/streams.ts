/**
 * Safari can't loop over a stream with `for await` yet, and pdf.js reads a page's words that way (and unpacks some
 * pictures that way). Without this, Change the words finds no words there and Place fields for me fails with
 * "undefined is not a function". A stream gets the loop the standard gives it, made from its reader, in a browser
 * that hasn't one. Called before pdf.js loads (`loadPdfJs`).
 */
export function letStreamsBeLooped(): void {
  const proto = globalThis.ReadableStream?.prototype as object | undefined;
  if (!proto || Symbol.asyncIterator in proto) return;

  function values(this: ReadableStream, options?: { preventCancel?: boolean }) {
    const reader = this.getReader();
    const preventCancel = options?.preventCancel ?? false;
    return {
      async next() {
        try {
          const step = await reader.read();
          if (step.done) reader.releaseLock();
          return step;
        } catch (e) {
          reader.releaseLock();
          throw e;
        }
      },
      // Leaving the loop early lets the stream go, as the standard's does.
      async return(value?: unknown) {
        const cancelled = preventCancel ? null : reader.cancel(value);
        reader.releaseLock();
        await cancelled;
        return { done: true as const, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  if (!('values' in proto))
    Object.defineProperty(proto, 'values', { value: values, writable: true, configurable: true });
  Object.defineProperty(proto, Symbol.asyncIterator, {
    value: values,
    writable: true,
    configurable: true,
  });
}
