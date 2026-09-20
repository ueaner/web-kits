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

/** Fail-fast validation for the millisecond configuration every primitive takes: it must be
 *  a positive finite number. A non-positive TTL makes every claim expire before (or the
 *  instant) it's written, so coordination silently stops coordinating; NaN behaves the same
 *  way; Infinity never expires, so a holder that dies without releasing blocks every other
 *  tab forever — the exact failure a TTL exists to prevent. These are misconfigurations, not
 *  runtime conditions, so they throw at construction (or call) time — surfaced on the app's
 *  first start or first test — rather than degrading silently. */
export function assertPositiveFiniteMs(value: number, apiName: string, paramName: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`cross-tab-kit: ${apiName}'s ${paramName} must be a positive finite number, got ${value}`)
  }
}
