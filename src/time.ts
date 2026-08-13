/**
 * Monotonic clock for measuring intervals. React Native exposes performance.now()
 * on supported runtimes; Date.now() is only a fallback.
 */
export function monotonicNowMs(): number {
  const performanceObject = globalThis.performance;
  if (performanceObject && typeof performanceObject.now === 'function') {
    return performanceObject.now();
  }
  return Date.now();
}
