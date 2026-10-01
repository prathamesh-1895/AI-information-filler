// Deployed entry point (Deno). All logic lives in handler.ts, which is tested in Node.
import { verifyToken } from '../_shared/deps.ts';
import { handleHealth } from './handler.ts';

Deno.serve((request) => handleHealth(request, { env: Deno.env, verifyToken }));
