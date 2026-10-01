// Deployed entry point (Deno). All logic lives in handler.ts, which is tested in Node.
import { createClient } from '@supabase/supabase-js';
import { handleHealth } from './handler.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  {
    auth: { persistSession: false, autoRefreshToken: false },
  },
);

Deno.serve((request) =>
  handleHealth(request, {
    env: Deno.env,
    verifyToken: async (jwt) => {
      const { data, error } = await admin.auth.getUser(jwt);
      return error || !data.user
        ? null
        : { id: data.user.id, ...(data.user.email ? { email: data.user.email } : {}) };
    },
  }),
);
