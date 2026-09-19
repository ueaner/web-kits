// Real-browser verification of cross-tab poll-leader election and the result relay — see
// fixture.ts's doc comment for why this exists alongside (not instead of) the jsdom vitest
// suite. Each test uses its own storageKey/pollLeaseKey so the three tests never contend with
// each other even though they all share the same browser's localStorage origin.
import { expect, test, type Page } from "@playwright/test"

interface StartOptions {
  storageKey: string
  pollLeaseKey: string
  pollLeaseTtlMs?: number
  pollTickMs?: number
  result?: "pending" | "success"
}

async function startPoller(page: Page, opts: StartOptions): Promise<void> {
  await page.goto("/test-e2e/fixture.html")
  await page.evaluate((o) => window.startPoller(o), opts)
}

async function checkCallsOf(page: Page): Promise<number> {
  return page.evaluate(() => window.checkCalls)
}

test("only one of two real tabs calls check() when both race for leadership", async ({ browser }) => {
  const context = await browser.newContext()
  const pageA = await context.newPage()
  const pageB = await context.newPage()

  const storageKey = "e2e-leader-election"
  const pollLeaseKey = `${storageKey}-poll-leader`
  // Explicit, generous pollLeaseTtlMs rather than the default (pollTickMs * 4 = 200ms here):
  // on a loaded CI runner, either tab's event loop stalling for just over 200ms between
  // renewals would let the other tab legitimately (if unexpectedly, for this test's purposes)
  // take over mid-run.
  const pollLeaseTtlMs = 2_000

  await startPoller(pageA, { storageKey, pollLeaseKey, pollLeaseTtlMs, pollTickMs: 50 })
  await startPoller(pageB, { storageKey, pollLeaseKey, pollLeaseTtlMs, pollTickMs: 50 })

  await pageA.waitForTimeout(500)

  const [callsA, callsB] = [await checkCallsOf(pageA), await checkCallsOf(pageB)]
  expect(callsA + callsB).toBeGreaterThan(0)
  expect(Math.min(callsA, callsB)).toBe(0)

  await context.close()
})

test("relays the leader's result to the other real tab's onResult via a genuine storage event", async ({ browser }) => {
  const context = await browser.newContext()
  const pageA = await context.newPage()
  const pageB = await context.newPage()

  const storageKey = "e2e-relay"
  const pollLeaseKey = `${storageKey}-poll-leader`
  const pollLeaseTtlMs = 2_000 // see the leadership-race test above for why this is explicit

  await startPoller(pageA, { storageKey, pollLeaseKey, pollLeaseTtlMs, pollTickMs: 50, result: "success" })
  await startPoller(pageB, { storageKey, pollLeaseKey, pollLeaseTtlMs, pollTickMs: 50, result: "success" })

  // Whichever tab wins leadership finalizes the task as "success" and relays it — the other
  // must receive it via a real `storage` event fired by an actual second browser tab, not a
  // synthetically dispatched StorageEvent the way the jsdom unit tests simulate it. Poll until
  // *both* tabs have a result, not just either one: the winner's own result lands synchronously
  // (from its own local finalize()), but the relay to the other tab is a genuinely separate,
  // asynchronous delivery — returning as soon as only one side is set would let the assertions
  // below race that delivery.
  await expect
    .poll(
      async () => {
        const [resultA, resultB] = [await pageA.evaluate(() => window.lastResult), await pageB.evaluate(() => window.lastResult)]
        return resultA !== null && resultB !== null
      },
      { timeout: 5_000 },
    )
    .toBe(true)

  const [resultA, resultB] = [await pageA.evaluate(() => window.lastResult), await pageB.evaluate(() => window.lastResult)]
  expect(resultA).toMatchObject({ status: "success" })
  expect(resultB).toMatchObject({ status: "success" })

  await context.close()
})

test("a real tab takes over once the original leader tab closes without releasing its lease", async ({ browser }) => {
  const context = await browser.newContext()
  const pageA = await context.newPage()
  const pageB = await context.newPage()

  const storageKey = "e2e-natural-expiry"
  const pollLeaseKey = `${storageKey}-poll-leader`
  const pollLeaseTtlMs = 300

  await startPoller(pageA, { storageKey, pollLeaseKey, pollLeaseTtlMs, pollTickMs: 50 })
  await startPoller(pageB, { storageKey, pollLeaseKey, pollLeaseTtlMs, pollTickMs: 50 })

  await pageA.waitForTimeout(300)
  // Figure out which of the two actually won the race, rather than assuming it's always pageA.
  const [leaderPage, followerPage] = (await checkCallsOf(pageA)) > 0 ? [pageA, pageB] : [pageB, pageA]
  expect(await checkCallsOf(leaderPage)).toBeGreaterThan(0)
  expect(await checkCallsOf(followerPage)).toBe(0)

  // Simulate the leader tab crashing/freezing — closed abruptly, no stop(), no explicit
  // release, exactly the case `pollLeaseTtlMs`'s doc comment describes.
  await leaderPage.close()

  await followerPage.waitForTimeout(pollLeaseTtlMs + 700)

  expect(await checkCallsOf(followerPage)).toBeGreaterThan(0)

  await context.close()
})
