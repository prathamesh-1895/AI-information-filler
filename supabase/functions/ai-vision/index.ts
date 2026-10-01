// Deployed entry point (Deno). All logic lives in handler.ts, which is tested in Node.
import { createGateway } from '../_shared/ai/gateway.ts';
import { consumeQuota, log, recordTokens, verifyToken } from '../_shared/deps.ts';
import { handleVision } from './handler.ts';

const gateway = createGateway({ env: Deno.env, fetch: (input, init) => fetch(input, init), log });

Deno.serve((request) =>
  handleVision(request, {
    env: Deno.env,
    verifyToken,
    gateway,
    consumeQuota,
    recordTokens,
    log,
  }),
);
