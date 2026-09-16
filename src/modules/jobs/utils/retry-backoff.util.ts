export function calculateBackoffSeconds(
  attempt: number,
  baseSeconds: number,
  maxSeconds: number,
): number {
  const exponential = Math.min(
    maxSeconds,
    baseSeconds * 2 ** Math.max(0, attempt - 1),
  );
  const jitterFactor = 0.8 + Math.random() * 0.4;
  return Math.max(
    1,
    Math.min(maxSeconds, Math.round(exponential * jitterFactor)),
  );
}
