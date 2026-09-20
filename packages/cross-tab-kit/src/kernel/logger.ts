/** Diagnostic-warning channel. Deliberately this minimal (`{ warn(message): void }`) rather
 *  than requiring a specific logging library's type, so any logger a caller already has —
 *  `console`, a structured logger, a telemetry client's own warn method — is already
 *  assignable here with no adapter needed. */
export interface Logger {
  warn(message: string): void
}

export function resolveLogger(logger?: Logger): Logger | undefined {
  return logger ?? (typeof console !== "undefined" ? console : undefined)
}

/** Shared validation for the `ttlMs` every TTL-based primitive takes: it must be a positive
 *  finite number. A non-positive TTL makes every claim expire before (or the instant) it's
 *  written, so coordination silently stops coordinating. NaN behaves the same way. Infinity
 *  is worse: the entry never expires, so if the holding tab dies without releasing, no other
 *  tab can ever take over — the exact failure a TTL exists to prevent. None of these is
 *  fatal (best-effort coordination just degrades), but all are almost certainly
 *  misconfigurations, so it's worth flagging at the point it's easiest to notice. */
export function warnOnInvalidTtl(logger: Logger | undefined, apiName: string, ttlMs: number): void {
  if ((Number.isFinite(ttlMs) && ttlMs > 0) || !logger) return
  try {
    logger.warn(`cross-tab-kit: ${apiName}'s ttlMs must be a positive finite number, got ${ttlMs}`)
  } catch {
    // A diagnostic channel must never take down the code path it's diagnosing — see `Logger`.
  }
}
