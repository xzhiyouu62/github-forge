// Entry lifecycle for the agent/v1 harness, implemented from the wire contract:
// read MAKEFUN_ENV_URL, bind an ephemeral port, POST {port} to the env's /register,
// then poll GET /done until the env ends the trial, close the server and exit 0.
// The forge itself lives in app.ts; this file only owns the process lifecycle.

import { createApp } from './app.ts';

// A larger young generation means fewer scavenges during request bursts;
// purely a runtime tuning knob for this process, set before the app loads.
try {
  const v8 = await import('node:v8');
  v8.setFlagsFromString('--max-semi-space-size=64');
} catch {
  // Older Node without the flag: run with defaults.
}

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

function backoff(attempt: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Register the bound port. 200 and 409 both mean the env knows an address for the
 *  entry (409: an earlier register won). 400/405 are contract errors: give up. */
async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let fatal: string | null = null;
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        fatal = `register answered HTTP ${res.status}: ${await res.text()}`;
      }
    } catch {
      // Network trouble or a timeout: the env may still be starting; retry.
    }
    if (fatal !== null) throw new Error(fatal);
    await pause(backoff(attempt));
  }
}

/** Poll the env's /done until its body says the trial is over. */
async function awaitDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // A failed poll means "not done yet", never a reason to exit early.
    }
    await pause(backoff(attempt));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);
  await announce(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await awaitDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
