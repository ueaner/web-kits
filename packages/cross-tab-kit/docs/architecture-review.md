# `docs/architecture.md` 审查意见

> 审查对象:`docs/architecture.md`(面向 v0.2 的架构提案,状态:提案)
> 审查范围:文档内部一致性、对 Web 平台特性的技术描述是否准确、提议的 API 设计有无已知弱点;同时对照当前
> 仓库实际代码(`src/tab-lock.ts`、`src/ttl-dedupe-cache.ts`、`src/poll-lease.ts`、`src/index.ts`)核实了文档
> 里关于"现状"的具体断言。
> 结论:整体设计思路扎实,一致性天花板表格、`pagehide` vs `beforeunload` 的取舍、fence 世代号的推理都是
> 站得住脚的判断,不是泛泛而谈。但发现 6 处问题,其中 3 处是具体的规格/设计缺陷,1 处是战略层面的规模判断,
> 值得在推进到实现前处理。

## 1. `LeadershipLoopOptions` 接口和后面的行为描述对不上——具体的规格错误

§5.1 的代码块里 `LeadershipLoopOptions` 只有 `lockName`/`renewIntervalMs`/`releaseOnExit`/`logger` 四个
字段,但紧接着的说明文字写"失去 leadership 时……`onLeadershipLost`(如有)被调用"——`onLeadershipLost`
从没在接口里声明过。

这不是排版疏漏级别的小问题:如果这个回调打算做成 API 的一部分,接口定义里漏了,需要补上字段和类型
(挂在 `LeadershipLoopOptions` 上,还是作为 `createLeadershipLoop` 的第五个参数?);如果决定不做,说明
文字又在承诺一个不存在的东西,读者会照着不存在的回调去写代码。两处必须对齐一个,不能都保留。

## 2. "loop 会不会重新尝试夺回 leadership" 被当成普通开放问题,分量被低估了

§10 第 2 条"失去 leadership 后是否自动尝试夺回(默认否,保持行为可预测)"看起来轻描淡写,但这直接
决定了整个 API 的语义形状:

- `onLeadership` 回调在 `createLeadershipLoop` 一次调用的生命周期里,是"最多触发一次"还是"每次拿到
  新任期都会再触发一次"?
- 如果默认"不夺回",这个函数名里的"loop"具体是在循环什么?只是循环续租,不循环选主?

这个问题不先回答,`onLeadership`/`onLeadershipLost`/`stop()` 三者的调用契约就没法真正定下来——它比
"要不要加只读 `inspect()`"这类锦上添花的问题更基础,建议单独列为发布前必须回答的阻塞项,不要跟其它
开放问题混在同一个列表里、同等优先级对待。

## 3. `renewIntervalMs` 的默认公式 `max(ttlMs/3, 1000)`,对小 `ttlMs` 会违反自己声明的不变式

§6.1 #7 的论证是"1/3 余量能容忍两次连续续租被节流延迟",这个算术在 `ttlMs` 较大时成立。但公式里
`max(_, 1000)` 这个下限,对短租约会让整条推理失效:比如 `ttlMs = 1500`,`ttlMs / 3 = 500`,被 1000ms
下限顶到 1000——续租间隔变成 TTL 的 2/3,而不是 1/3,"容忍两次延迟"的保证直接不成立,甚至可能违反
文档自己写的硬约束"必须显著小于 ttlMs"。

这个下限本身的动机(避免后台标签页定时器被过度节流拖慢续租)是合理的,但公式需要在 `ttlMs` 很小时
有别的处理方式——比如同时给 `ttlMs` 定一个建议下限,或者让 1000ms 这个下限本身也按 `ttlMs` 的比例
收缩——不能让两个默认值在小 `ttlMs` 场景下互相打架。

## 4. `releaseOnExit` 靠 `pagehide` 自动 release,承诺比浏览器实际能给的保证更强

选 `pagehide` 而不是 `beforeunload` 是对的判断(bfcache 时代唯一可靠的"页面即将消失"钩子)。但
`pagehide` 处理函数里如果 `release()` 本身是异步操作(比如需要先拿一次 `withTabLock` 才能安全写
tombstone),浏览器并不保证在页面真正终止前把这段异步工作跑完。

这跟文档自己在 §3 表格里"诚实优先"的原则不一致:那张表对每一条平台限制都写清楚了失效模式,唯独这里
的"自动 release"读起来像一个可以依赖的保证。好在设计本身有 TTL 兜底,不会真的出大问题,但措辞上应该
明确写成"尽力而为,不保证一定跑完,失败时退回到 TTL 自然过期",而不是只写"自动 release"。

## 5. `ifAvailable` 的函数重载设计,在非字面量调用点会静默失配

§5.3 提议用重载区分 `ifAvailable` 开/关两种返回类型,这个模式的已知弱点是:TypeScript 的重载匹配
依赖调用点参数的**静态字面量类型**。如果调用方是这样写的:

```ts
const opts: TabLockOptions = { ifAvailable: someCondition }
await withTabLock("name", fn, opts)
```

`someCondition` 一旦不是字面量 `true`,重载解析大概率落到不开 `ifAvailable` 的那个签名,返回类型变成
`Promise<T>` 而不是 `Promise<{acquired...}>`,但运行时行为却是按 `ifAvailable` 语义执行的——类型和
运行时行为对不上,而且编译期不会报错,只会在后续代码里把 `result` 当成 `T` 用,产生一个隐蔽的类型
错误。

建议二选一:要么在文档里明确提示"必须以对象字面量形式内联传入 options,不要先赋值给变量再传",要么
换成不依赖重载的设计(比如返回值永远是 `{acquired, value}` 形状,不开 `ifAvailable` 时 `acquired`
恒为 `true`,牺牲一点点向后兼容换取类型安全)。

## 6. 战略层面:v0.1.0 发布仅几天就提议一次性加这么大面积的 API,值得权衡

这不是具体的技术错误,是希望你自己权衡的判断。这次提案一次性加了:L2 新 API
(`createLeadershipLoop`)、`withTabLock` 两个方向的扩展(cancelable operation + `ifAvailable`)、
`TtlDedupeCache` 两个新能力(`has`/`maxEntries`)、模块重排——面积不小。文档自己在 §2 定位里写的
设计信条第 2 条是"原语最小、可组合",而这次最大的新增恰恰是一个新的高阶封装层。

这不代表 L2 这个方向不对——§6.1 的论证确实解决了真实的样板错误问题。只是想提醒:这些都是**在还没有
真实外部使用反馈的情况下**,基于"上一轮评审的 15 条注意事项"推导出来的——如果那 15 条本身来自一次
假设性走查而不是真实踩坑,现在就把 API 面积定死成 v0.2 稳定 API,以后发现设计不对时改起来的代价
(已经是公开 API,且第 1、2 条指出的规格问题还没解决)会比现在多验证一段时间更贵。建议至少
`createLeadershipLoop` 这个最大的新增,考虑先以 `@alpha` 标记或 README recipe 的形式跑一段时间,
而不是直接进 v0.2 稳定 API。

## 7. 核实无误、不需要改动的部分

- `ttl-dedupe-cache.ts` 确实在从 `poll-lease.ts` 反向 import `Logger`(§5.5 的诊断准确,当前
  `src/ttl-dedupe-cache.ts` 第 1 行就是 `import type { Logger } from "./poll-lease"`)。
- `#6 非法 ttlMs` 那条确实已经在当前未提交的代码里修了:`Number.isFinite` 校验 + 告警,
  `poll-lease.ts`/`ttl-dedupe-cache.ts` 两边都有,`tab-lock.ts` 也已经补上了"Web Locks 不可重入、
  多把锁顺序不一致会死锁"的文档警告。
- 15 条注意事项在 §6.1-6.3 里的分类(7 + 2 + 6 = 15)和 §6.4 汇总表核对下来编号没有遗漏或重复,
  内部一致。
- Web Locks API 相关的技术描述(`ifAvailable`、`steal`、`mode: "shared"`、不可重入)均准确,
  `pagehide` 在 bfcache 场景下比 `beforeunload` 更可靠这一判断也准确。
- `() => T` 到 `(ctx) => T` 的签名扩展,TypeScript 结构化类型下确实向后兼容(参数更少的函数可以
  赋值给参数更多的函数类型),§5.2 "向后兼容"的说法站得住。
