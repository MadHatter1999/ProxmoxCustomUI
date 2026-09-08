import crypto from 'node:crypto'

/** Short, URL-safe, sortable-enough device ids: "and-l8x2q4t9". */
export function newDeviceId(): string {
  return `and-${crypto.randomBytes(5).toString('hex')}`
}

/** Safe for AVD names, VM names and file paths alike. */
export function slug(input: string, fallback = 'device'): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return s || fallback
}

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** Human byte sizes for status text. */
export function gb(n: number): string {
  return `${Math.round(n * 10) / 10} GB`
}

/**
 * Poll until `check` returns something truthy, or give up.
 * Returns null on timeout rather than throwing - callers want to write their
 * own sentence about what timed out.
 */
export async function waitFor<T>(
  check: () => Promise<T | null | undefined>,
  opts: { timeoutMs: number; intervalMs: number; onTick?: (elapsedMs: number) => void }
): Promise<T | null> {
  const started = Date.now()
  for (;;) {
    const elapsed = Date.now() - started
    if (elapsed > opts.timeoutMs) return null
    try {
      const got = await check()
      if (got) return got
    } catch {
      /* transient - keep waiting, the timeout is the backstop */
    }
    opts.onTick?.(elapsed)
    await sleep(opts.intervalMs)
  }
}
