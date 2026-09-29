import { HfosError, isHfosError } from '@hfos/core/server';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';

/** Every error body says what a client keeping a queue should do with it (`disposition`, see core's errors). */
export function errorHandler(error: FastifyError, req: FastifyRequest, reply: FastifyReply): void {
  if (isHfosError(error)) {
    void reply.status(error.status).send(error.toBody());
    return;
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    const details = error.validation.map((v) => ({
      path: String(v.instancePath ?? '')
        .replace(/^\//, '')
        .replace(/\//g, '.'),
      message: v.message ?? 'Invalid value',
    }));
    void reply.status(400).send(HfosError.validation(details).toBody());
    return;
  }
  if (isResponseSerializationError(error)) {
    req.log.error({ err: error }, 'response failed output validation');
    void reply.status(500).send(HfosError.internal().toBody());
    return;
  }
  if (error.statusCode === 429) {
    void reply.status(429).send({
      error: {
        code: 'rate_limited',
        message: 'Too many attempts. Try again in a minute.',
        disposition: 'retry',
      },
    });
    return;
  }
  // A body over the limit can never be taken as it is, so it isn't one to send again.
  if (error.statusCode === 413) {
    void reply
      .status(413)
      .send(
        new HfosError(
          'validation',
          413,
          'That’s too much to send at once. Make it shorter, or split it into smaller parts, and try again.',
        ).toBody(),
      );
    return;
  }
  if (error.statusCode === 415 || error.statusCode === 400) {
    void reply.status(400).send(HfosError.validation(undefined, error.message).toBody());
    return;
  }
  req.log.error({ err: error }, 'unhandled error');
  void reply.status(500).send(HfosError.internal().toBody());
}
