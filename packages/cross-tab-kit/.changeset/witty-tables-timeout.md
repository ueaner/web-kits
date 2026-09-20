---
"cross-tab-kit": minor
---

Hardening on top of 0.1.0: poll-lease rejects lease records with non-finite numbers (an out-of-range literal like `1e999` parses to `Infinity` and could never lapse, blocking takeover forever) and warns on a `NaN`/`Infinity` `ttlMs`; `createTtlDedupeCache` gains an `options.logger` channel with the same `ttlMs` validation, no longer rewrites storage on a repeat claim when nothing expired, and treats malformed stored entries as expired instead of throwing.
