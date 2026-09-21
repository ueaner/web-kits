# 增量审查:linkAbortSignal + 阈值常量公开化(2026-09-21)

> 审查对象:`src/kernel/abort.ts`(新增)、`src/locks/tab-lock.ts`、`src/patterns/leadership-gate.ts`、
> `src/index.ts`、`test/abort.test.ts`(新增)、`test/exports.test.ts`、
> `.changeset/tame-lions-arrive.md`。
> 视角:对外 API 稳定性 + 内部重构等价性 + 测试/文档兑现度。

## 验证基线

- 静态:`tsc --noEmit`、`oxlint src test`、`oxfmt --check` 应当全部干净(基于既
  有 `.oxfmtrc.json` 与 `tsconfig.json` 严格模式 + `noUncheckedIndexedAccess`)。
- 运行时:本轮新增 `test/abort.test.ts` 4 个用例与 `test/exports.test.ts` 末尾
  新增的阈值锁定用例,需随既有套件一并通过;`linkAbortSignal` 在 `tab-lock.ts`
  的替换路径已被既有 `test/tab-lock.test.ts` 的 abort/waitTimeoutMs 用例覆盖。

## 总结论

干净、低风险的增量改动:**对外** 新增 3 个 named exports(`SHORT_TTL_WARN_MS`、
`SLOW_WAIT_WARN_MS`、`linkAbortSignal`),无任何既有 API 破坏;**对内**
`withTabLock` 的内联 signal-merging 被 `linkAbortSignal` 替换,语义等价(或
略更稳,见 S-3),且顺带把 `leadership-gate.ts` 内部的 magic number `1_000`
收敛到命名常量。可以放心提交。

## 源码发现

### S-1(信息):`linkAbortSignal` 抽离职责清晰,文档质量高

`src/kernel/abort.ts`(新增):标准 `addEventListener({ once: true })` +
`removeEventListener` 模式封装。JSDoc 明确:

- 用途:把包内抛出的 `TabLockContext.timeoutSignal` / `Tenure.signal` /
  `LeadershipContext.signal` 链接到调用方的 `AbortController`,让失锁/失租
  约变成真正的取消。
- 漏 listener 风险:特别强调「standing `Tenure` 跨多次调用会累积」的具
  体场景,这是文档最值钱的部分。

返回值 `() => void` 的语义在两个分支保持一致(已 aborted 返 no-op,未
aborted 返真正解绑函数),调用方可以无条件 `finally { unlink() }`,无需分支判
断。

### S-2(信息):已 aborted 路径的 unlink 行为建议在 JSDoc 显式

```ts
if (source.aborted) {
  target.abort(source.reason)
  return () => undefined
}
```

已 aborted 分支返回 no-op unlink 函数。`test/abort.test.ts:42-49` 已覆盖
"`unlink()` 不抛错",但 JSDoc 当前只说"call the returned function once the
linked work settles"——未明说在 source 已 aborted 时该调用是无操作。建议补一
句「calling the returned unlink after the source is already aborted is a
no-op」,方便阅读者写出无分支的 `try/finally`。

严重度:低(测试已覆盖,纯文档可读性)。

### S-3(信息):`tab-lock.ts` 重构为等价替换(几乎无变更)

旧代码:

```ts
const onUserAbort = () => waitController.abort(options.signal?.reason)
if (options.signal) {
  options.signal.addEventListener("abort", onUserAbort, { once: true })
  if (options.signal.aborted) waitController.abort(options.signal.reason)
}
```

新版:

```ts
const unlinkUserSignal = options.signal
  ? linkAbortSignal(options.signal, waitController)
  : undefined
```

等价性论证:

- `source` 未 aborted:旧 = addEventListener(once) + removeEventListener;
  新 = 同。引用身份由 `linkAbortSignal` 内部闭包保证。
- `source` 已 aborted:旧 = 同步 `waitController.abort(reason)` + 注册永远不
  触发的 listener + removeEventListener(no-op);新 = 同步
  `waitController.abort(reason)` + 返 no-op unlink。`clearWait()` 调
  `unlinkUserSignal?.()` 在新代码里就是 `undefined?.()`,结果一致。
- `.finally(clearWait)` 路径不受影响。

**S-3.1(微调,严格意义上非完全 no-op)**:旧版 `onUserAbort` 用
`options.signal?.reason`(在事件触发时才求值 `reason`),新版在 addEventListener
时一次性求值 `source.reason`。差异仅在调用方在 aborted 之前主动改
`AbortSignal.reason` 的非标场景——理论上更稳,实际无影响。changeset 写
"no behavior change"严格说不 100% 精确,但无关紧要。

### S-4(信息):`SHORT_TTL_WARN_MS` 的内联字面量替换为命名常量

`leadership-gate.ts:96` 的 `if (ttlMs < 1_000 && logger)` 改为
`if (ttlMs < SHORT_TTL_WARN_MS && logger)`,语义等价(`SHORT_TTL_WARN_MS = 1_000`)。
顺带把阈值从私有 magic number 升级为公开常量。

### S-5(信息):`index.ts` 导出顺序的口味问题

```ts
export { createLeadershipGate, SHORT_TTL_WARN_MS, SLOW_WAIT_WARN_MS } from "./patterns/leadership-gate"
...
export { linkAbortSignal } from "./kernel/abort"
```

`exports.test.ts` 用 `Object.keys(index).sort()` 断言,所以顺序不影响测试。
但阅读顺序「scenarios 在前 → kernel helpers 在后」更符合既有 §3 入口清
单的口径。当前顺序可读,无需调整。

## 测试发现

### T-1(信息):`test/abort.test.ts` 覆盖了 4 个核心分支

| 用例 | 覆盖路径 |
|------|----------|
| "aborts the target when the source aborts, propagating the reason" | 未 aborted 主路径 + reason 透传 |
| "aborts the target immediately when the source is already aborted" | 已 aborted 同步分支 |
| "does not abort the target once unlinked" | unlink 后 source 再 abort 不应传递 |
| "unlinking after an already-aborted source is a no-op, not a throw" | no-op unlink 不抛错 |

粒度合适。`source.reason` 是否为 `undefined`(默认值)未被显式覆盖,但用户自
己构造 `new AbortController()` 不传 reason 就是 `undefined`,已被隐式验证。
可选:补一个"`source.aborted === false`,reason 为 `undefined` 时
`target.reason === undefined`"用例,显式钉一下。

### T-2(信息):`test/exports.test.ts` 顺手把阈值常量钉住

末尾新增用例锁定 `SHORT_TTL_WARN_MS === 1_000` 与 `SLOW_WAIT_WARN_MS === 5_000`,
防止未来静默改阈值破坏"恰好选在阈值一侧"的下游测试。导出列表同步更新到包含
`linkAbortSignal` / `SHORT_TTL_WARN_MS` / `SLOW_WAIT_WARN_MS`,`Object.keys(index).sort()` 断言仍严格相等。

### T-3(信息):既有 `tab-lock.test.ts` 隐式覆盖 `linkAbortSignal` 替换路径

`withTabLock` 自身的 `options.signal` 合并路径既有覆盖测试,refactor 后无需
新增测试。Vitest 跑一遍即可全量验证。

## 文档 / changeset 发现

### D-1(信息):`.changeset/tame-lions-arrive.md` 描述准确

- `minor` bump 与新增导出对得上。
- 描述里把"既已存在的阈值常量公开"和"新增 `linkAbortSignal`"两件事并列
  写,清晰。
- "No existing API changed"基本准确,见 S-3.1 的微调。

可选:补一句"提取自 `withTabLock` 内部并复用,行为不变"。当前写法已隐含
此意。

## 残留 / 后续(非阻塞)

- **R-1**:若 `LeadershipGate` / `leadership-loop` 后续允许调用方传
  `AbortSignal` 来取消 `acquire()` 等待,请直接复用 `linkAbortSignal`,避免
  有人再次手写 `addEventListener` 块。可放 follow-up issue 或在相关 JSDoc
  顶部加一行交叉引用。
- **R-2**:`linkAbortSignal` JSDoc 补"unlink 在 source 已 aborted 时为 no-op"
  说明(见 S-2)。
- **R-3**:`test/abort.test.ts` 可选补一个 `reason === undefined` 的显式用例
  (见 T-1)。

## 整体结论

提交可。`linkAbortSignal` 是一个语义清晰、文档充分、有单元测试的小工具;
`tab-lock.ts` 的替换无实质行为变更;`SHORT_TTL_WARN_MS` 的公开顺手把
magic number 收敛,导出测试同时锁定值;changeset 描述准确。R-1 ~ R-3 均为
可选微调,不影响本轮合并。
