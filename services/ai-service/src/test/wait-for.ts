// Poll until a condition holds, or fail with a NAMED reason.
//
// ── Why this exists ───────────────────────────────────────────────────────
// The integration tests were sprinkled with `await sleep(WINDOW + 300)`. A
// fixed sleep encodes a guess about how fast the machine is: too short and the
// suite is flaky under load (measured — the worker-lost repro failed in the
// full integration run and passed in isolation), too long and every run pays
// the worst case. Polling to a DEADLINE is both faster on a fast machine and
// safe on a slow one.
//
// ⚠ Poll the CONDITION, not the clock. `waitFor(() => elapsed > windowMs)` is a
// fixed sleep with extra steps; `waitFor(() => postgresSaysTheRowIsPast())`
// waits on the thing the production code will actually read.

/** Resolve when `read()` returns a truthy value; throw at the deadline. */
export async function waitFor<T>(
  read: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  what: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const intervalMs = opts.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (v) return v as T;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
