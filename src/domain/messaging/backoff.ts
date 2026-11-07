export function backoffDelayMs(attempt: number, baseMs = 1000, capMs = 300_000): number {
  return Math.min(capMs, baseMs * 2 ** (attempt - 1));
}
