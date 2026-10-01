/** Minimal Deno globals used by the Edge Function entry points (for Node-side typechecking). */
declare namespace Deno {
  const env: { get(name: string): string | undefined };
  function serve(handler: (request: Request) => Response | Promise<Response>): unknown;
}
