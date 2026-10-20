import { base58 } from "@scure/base";
/** Deterministic fake base58 address from a small integer. */
export function addr(n: number): string {
  const b = new Uint8Array(32);
  b[0] = 7; // avoid leading zero bytes (which encode as '1')
  b[30] = (n >> 8) & 0xff;
  b[31] = n & 0xff;
  return base58.encode(b);
}
export const MINT = addr(9999);
export function shuffle<T>(xs: readonly T[], seed: number): T[] {
  const a = [...xs];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
