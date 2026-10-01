// Deployed entry point (Deno). All logic lives in handler.ts, which is tested in Node.
import { createGateway } from '../_shared/ai/gateway.ts';
import { cache, consumeQuota, log, recordTokens, verifyToken } from '../_shared/deps.ts';
import { handleClassify } from './handler.ts';

const gateway = createGateway({ env: Deno.env, fetch: (input, init) => fetch(input, init), log });

Deno.serve((request) =>
  handleClassify(request, {
    env: Deno.env,
    verifyToken,
    gateway,
    consumeQuota,
    recordTokens,
    cache,
    log,
  }),
);
