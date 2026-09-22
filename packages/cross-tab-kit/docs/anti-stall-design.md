# 防卡死设计(Anti-Stall Design)

> 状态:**部分采纳,部分被上游决策取代**(见下方逐条结论)。原定位"v0.2.0 或
> v0.3.0、纯加法、无 breaking"的前提已不成立——`withTabLock.waitTimeoutMs`
> 在本文写成之前就已在 v0.2.0 改为必传(breaking),不是本文设想的可选路线。
> 关联:`architecture-greenfield.md` §4(锁层)、§8(失效矩阵);本文补全其中
> 「卡死」这一失效类别的剩余空白。
>
> **采纳结论**(下一个 minor,见 changeset `gentle-otters-relax`):
>
> - §2.1(`TabLockOptions.waitTimeoutMs` 可选)—— ❌ **不采纳**:与已发布的
>   v0.2.0 必传设计方向相反,回退等于再来一次 breaking change,价值不足。
> - §2.2 gate/loop 默认 `waitTimeoutMs = ttlMs` —— ✅ **已在 v0.2.0 落地**
>   (`leadership-gate.ts:86`),与本文提案殊途同归,早于本文写作。
> - §2.2「等锁超时按『本次未获 leadership』处理,不抛给调用方」—— ✅ **本轮
>   采纳并实现**:`acquire()`/`isStillValid()` 等锁超时现在 resolve
>   `null`/`false`,不再 reject `TimeoutError`。`withTabLock`/`tryWithTabLock`
>   本身不受影响,仍然 reject。
> - §2.3 等待超阈值告警一次 —— ✅ **本轮采纳并实现**(与上一条配套:不 reject
>   之后,这条 warn 是唯一的可观测性来源),阈值取 `waitTimeoutMs / 2` 与
>   5s(固定上限)中的较小者,每个 gate 实例只告警一次。
> - §2.2「`stop()`/`release()` 中止在途等锁」—— ⏸ **未采纳,认定优先级较低**:
>   `waitTimeoutMs` 本身已经有界(最坏等到 `ttlMs`),不是本文写作时设想的
>   「无界卡死」,暂不实现;需要时可作为独立提案重提。

## 1. 问题定义:这个库里的「卡死」只有三种形态

跨标签页协调中,一个 tab 永久卡住不恢复的场景,穷举下来只有:

| 形态                | 机理                                                                         | 现状                                                                   |
| ------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **F1 持锁方挂起**   | operation 是永 settles 的 promise(代码 bug、等一个永远不来的响应),锁永久持有 | `timeoutMs` 已覆盖(持锁方自救),但只有调用方主动传才生效                |
| **F2 等待方挂起**   | `navigator.locks.request` 排在 F1 的持有者后面,等待无限期                    | **无任何防护**——`timeoutMs` 明确不管等待阶段,只有调用方自己传 `signal` |
| **F3 角色无人承担** | leader 死亡/冻结,无人接管轮询/连接                                           | 已由 TTL 租约自愈覆盖,不在本文范围                                     |

**F2 是唯一的空白**,也是本文的对象。

### 平台事实(设计的约束输入)

- tab 被杀/崩溃:浏览器自动释放其持有的所有锁和排队的锁请求——F1/F2 对「死掉
  的 tab」不存在,只对「活着但挂起」的 tab 存在
- bfcache:Chrome 中**持有锁或锁请求的页面不能进 bfcache**(卸载尝试时锁会被终止,
  页面不进入可缓存状态),所以「冻结在 bfcache 里还持着锁」在 Chrome 不是现实场景;
  Safari/Firefox 未验证,设计按「冻结持锁可能存在」保守对待
- 后台 intensive throttling(隐藏 >5 分钟,定时器对齐到分钟级):持锁的 operation
  只是**变慢**,不是挂死——这模糊了「慢」和「死」的边界,直接决定了下面
  等待上限的取值原则
- 库**不透传 `steal`**(绿地 §4):等待方永远不能抢锁,任何等待方防护都只能是
  自救(放弃等待),不能解决持有者本身

## 2. 设计:`waitTimeoutMs` —— 等锁阶段的有界化

### 2.1 锁层 API(纯加法)

```ts
export interface TabLockOptions {
  signal?: AbortSignal // 已有:中止等锁阶段(平台语义)
  timeoutMs?: number // 已有:约束 operation 执行期
  /** 等锁阶段的上限:排队超过这个时长还没拿到锁,reject TimeoutError。
   *  与 timeoutMs 完全正交:一个管"等多久",一个管"干多久"。
   *  等待超时不影响持有者分毫——它只是让这个等待方放弃排队(自救)。
   *  无 Web Locks 的降级路径上没有"等锁"概念,此选项被忽略。 */
  waitTimeoutMs?: number
}
```

`tryWithTabLock` 同样接受(语义退化为:ifAvailable 拿不到立刻跳过,本来就无等待;
`waitTimeoutMs` 在它上面是 no-op,文档写明即可,不需要拒绝)。

**实现**:内部把 `AbortSignal.timeout(waitTimeoutMs)` 与 `options.signal` 用
`AbortSignal.any()` 合成后传给 `locks.request`;等锁超时的 rejection 归一化为
`TimeoutError`(与 `timeoutMs` 的报错类型一致,调用方一种 catch 就够)。

**取值指引**(写进文档):等待上限应当**显著长于**后台节流周期(分钟级),否则会
把「holder 只是被节流得慢」误判为「holder 死了」而放弃排队——放弃本身无害(等锁
不是租约,放弃了再排就是),但无谓的放弃-重排是抖动来源。建议默认值不设(保持
现状:不传就无限等,与平台默认一致),由场景层显式给。

### 2.2 模式层:把 F2 的防护做成默认行为

锁层保持「不传不管」的平台语义,但 **patterns 层内部必须默认有界**——因为 loop/gate
的用户没有理由预期一个协调原语会把它的 tick 循环永久卡沉默:

**`createLeadershipGate`**:`acquire()`/`isStillValid()` 内部的 claim 等锁,默认
`waitTimeoutMs = ttlMs`。理由:等一个比租约 TTL 还久的锁没有意义——即使等到了,
你想保护的那段任期窗口也早过了。等锁超时按「本次未获 leadership」处理
(`acquire()` 返回 null,`isStillValid()` 返回 false),与「别人持有」同等地位,
不抛给调用方。可被 `options.waitTimeoutMs` 覆盖(包括显式 `undefined` 恢复无界)。

**`createLeadershipLoop`**:继承 gate 的行为。额外收益:修复一个现存隐患——
`tick` 卡在 `gate.acquire()` 的锁等待上时,`ticking` 永远为 true,后续 tick 全部
短路,这个 tab 的 loop 变成永久沉默的僵尸(系统层不死:租约过期后别的 tab 接管;
但本 tab 从此不再参与)。等待有界后,tick 最多卡 `ttlMs` 时长。

**stop()/release() 中止在途等锁**:模式层内部的等锁请求还应绑定一个生命周期
AbortSignal——`stop()`/`release()` 时 abort 掉任何仍在排队的 `acquire()`,让它
立刻以 AbortError 结束而不是排到若干年后才醒。这与 waitTimeoutMs 独立:一个是
「等太久」,一个是「我不玩了」。

### 2.3 诊断:等待超阈值告警一次

模式层在等待超过 `waitTimeoutMs / 2`(或固定 5s,取小)仍未拿到锁时,经 `logger`
warn 一次(每个 gate 实例只告警一次,不每 tick 重复):「排在某个疑似挂起的持有者
后面」。卡死的第一症状在今天的可观测性里是**什么都没有**——没有异常、没有日志、
只是静默地不再发生。一条 warn 把它从「用户报障后捞日志」提前到「开发期可见」。

### 2.4 明确不做

- **不透传 `steal`**(维持绿地 §4):等待方作废持有者的互斥假设,是把 F1 的
  「持有者挂起」变成「持有者活着但互斥失效」——更糟
- **不做持有者看门狗**:库无法判断一个 operation 是「慢」还是「死」,区分权只能
  在写 operation 的人手里(所以 `timeoutMs` 是指引,不是默认)
- **不做 `navigator.locks.inspect()` 暴露**:等真实需求(绿地 §9)

## 3. API 变更摘要

| 位置                    | 变更                                     | 性质                                      |
| ----------------------- | ---------------------------------------- | ----------------------------------------- |
| `TabLockOptions`        | + `waitTimeoutMs?: number`               | 纯加法                                    |
| `LeadershipGateOptions` | + `waitTimeoutMs?: number`(默认 `ttlMs`) | 纯加法,默认值改变行为(等锁从无限变为有界) |
| `LeadershipLoopOptions` | 继承 gate 的同名选项                     | 同上                                      |
| 模式层内部              | stop()/release() abort 在途等锁          | 行为修复(僵尸 loop 隐患)                  |
| 诊断                    | 等待超阈值 warn 一次                     | 纯加法                                    |

语义变化声明:gate/loop 的等锁从「无限」变为「默认 `ttlMs` 有界」是行为变化,但
方向是把一个静默卡死面变成受控降级;按 0.x 约定走 minor,changeset 里写明。

## 4. 测试计划(harness 已具备全部所需能力)

1. **等待方超时**:fake-locks 持有锁永不释放(现有剧本机制),`waitTimeoutMs` 到期
   → 等待方 reject `TimeoutError`,持有者不受影响
2. **僵尸 loop 修复**:holder 永不释放 → loop 的 tick 卡住 → 等锁超时后下一个
   tick 恢复参与(租约已过期,能正常 claim 成为 follower/leader)
3. **stop() 中止排队**:acquire 排队中调 stop() → 等待立即以 AbortError 结束,
   不等到锁空出来
4. **waitTimeoutMs 与 timeoutMs 正交**:等锁超时不 abort `ctx.timeoutSignal`;
   执行超时不影响等待者
5. **降级路径**:无 Web Locks 时 `waitTimeoutMs` 被忽略,行为与现状一致
6. **告警只发一次**:等待超阈值触发一次 logger.warn,后续 tick 不重复

## 5. 对下游(pending-task-kit)的影响

无破坏性。pending-task-kit 的引擎在 stop() 时自行 abort 在途 `check()`,与模式层
新增的等锁中止是同方向语义;gate 等锁默认有界后,`acquire()` 慢病理的暴露面从
「永久卡死」变成「null 返回,下个 tick 再来」,恰好是引擎已经在处理的返回形态。
