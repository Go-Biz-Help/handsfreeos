/** The token policy lives in core so the worker's HTTP routes verify tokens exactly like the API. */
export { bearerToken, createTokenVerifier, type TokenVerifier } from '@hfos/core/server';
