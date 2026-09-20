import { describe, expect, it } from "vitest"
import * as advanced from "../src/advanced"
import * as index from "../src/index"
import type { Logger, PollLeaseClaimer, PollLeaseClaimerOptions, PollLeaseClaimResult } from "../src/advanced"
import type { LeadershipContext, TabLockOptions, TabLockResult, Tenure, TryTabLockOptions } from "../src/index"

// The export discipline is part of the API contract (§3, §8 of the greenfield doc): the
// main entry is scenario-level API only, primitives live behind ./advanced. These tests
// cover the *source-level* surface only — the published dist exports map ("." and
// "./advanced", types + default) is verified by publint, which runs after the build in CI.
//
// The named type imports above are the compile-time half of the contract: `PollLeaseClaimer`
// / `PollLeaseClaimerOptions` / `PollLeaseClaimResult` are explicitly depended on by the
// first downstream (R2) — deleting or renaming one must fail tsc, so each is used to
// annotate a real value below (not just imported).

const claimerOptions: PollLeaseClaimerOptions = { logger: { warn: () => undefined } }
const claimer: PollLeaseClaimer = advanced.createPollLeaseClaimer("exports-types", 1_000, claimerOptions)
const claimResult: PollLeaseClaimResult = claimer.claim("exports-owner")
const advancedLogger: Logger = { warn: () => undefined }

describe("export surface", () => {
  it("main entry exports exactly the scenario-level API", () => {
    expect(Object.keys(index).sort()).toEqual(
      ["createLeadershipGate", "createLeadershipLoop", "createTtlDedupeCache", "tryWithTabLock", "withTabLock"].sort(),
    )
  })

  it("advanced entry exports the primitives and safe storage helpers", () => {
    expect(Object.keys(advanced).sort()).toEqual(
      ["createPollLeaseClaimer", "generatePollOwnerId", "safeGetItem", "safeRemoveItem", "safeSetItem"].sort(),
    )
  })

  it("the R2 named types from advanced are usable as annotations", () => {
    expect(claimerOptions.logger).toBeDefined()
    expect(claimResult).toEqual({ leader: true, fence: 1 })
    expect(typeof advancedLogger.warn).toBe("function")
  })

  it("the main entry's types are usable as annotations", () => {
    const result: TabLockResult<number> = { acquired: true, value: 1 }
    // TabLockOptions.waitTimeoutMs is required (the wait bound is a forced explicit choice);
    // TryTabLockOptions omits it — tryWithTabLock never queues, so there is no wait to bound.
    const lockOptions: TabLockOptions = { waitTimeoutMs: 1_000 }
    const tryOptions: TryTabLockOptions = {}
    const describeCtx = (ctx: LeadershipContext): number => ctx.fence
    const describeTenure = (tenure: Tenure): AbortSignal => tenure.signal
    expect(result.acquired).toBe(true)
    expect(lockOptions.waitTimeoutMs).toBe(1_000)
    expect(tryOptions.signal).toBeUndefined()
    expect(typeof describeCtx).toBe("function")
    expect(typeof describeTenure).toBe("function")
  })
})
