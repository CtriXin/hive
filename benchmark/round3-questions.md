# Hive 模型评测 — Round 3

> 维度重点：implementation + code_review + spec_adherence
> 满分：50 分（5 个 TASK × 10 分）
> 派发方式：统一 prompt → dispatch_single 并行 → Claude 交叉打分

---

## TASK1: Implementation — 带限流的重试队列（工程编码）

```
用 TypeScript 实现一个 RetryQueue<T>，用于管理失败任务的重试调度。要求：

1. 基本 API：
   - enqueue(item: T, options?: { maxRetries?: number; backoffMs?: number }): string  // 返回 taskId
   - cancel(taskId: string): boolean
   - getStatus(taskId: string): 'pending' | 'retrying' | 'succeeded' | 'failed' | 'cancelled' | undefined
   - onComplete(callback: (taskId: string, result: 'succeeded' | 'failed') => void): void

2. 重试策略：
   - 指数退避：第 N 次重试间隔 = backoffMs × 2^(N-1)，上限 30 秒
   - 默认最大重试 3 次，backoffMs 默认 1000ms
   - 并发限制：同时执行的任务不超过 concurrency（构造参数，默认 3）

3. 执行器：
   - 构造函数接收 executor: (item: T) => Promise<boolean>
   - executor 返回 true 表示成功，false 表示失败需重试
   - executor 抛异常也视为失败

4. 要求：
   - 完整 TypeScript 类型
   - 至少 5 个测试用例：正常成功、重试后成功、重试耗尽失败、取消、并发限制
   - 不依赖任何外部库（纯 TypeScript + setTimeout/Promise）
```

**考察点（对应 profiler 维度：implementation）：**
- 并发控制是否真正生效（不是写了个 counter 但没 await）
- 指数退避是否有 cap + 计算正确
- 状态机转换是否完备（无非法状态迁移）
- Promise 链是否有内存泄漏风险
- 测试是否覆盖时序边界（cancel 在执行中 vs 等待中）

**评分细则：**

| 分数 | 标准 |
|------|------|
| 9-10 | 并发池正确（Semaphore 或 slot 模式），指数退避有 cap，状态机完备，>=5 测试含时序边界，类型完整 |
| 7-8 | 功能正确但并发控制有小瑕疵（如 race condition），或测试不够深入 |
| 5-6 | 核心逻辑正确但并发限制失效或退避计算错误 |
| 3-4 | 基本框架有但多处 bug（状态不一致、cancel 无效等） |
| 1-2 | 功能严重缺失或不可运行 |

---

## TASK2: Code Review — 找出并修复 TypeScript 代码中的 Bug

```
以下是一个 TypeScript 模块，用于管理分布式锁（Distributed Lock Manager）。
代码中隐藏了 6 个 bug（3 个严重 / 2 个中等 / 1 个低危）。

请：
1. 逐一列出每个 bug 的位置、严重程度、问题描述
2. 给出修复后的完整代码
3. 说明每个 bug 在生产环境可能造成的后果

---

interface LockOptions {
  ttlMs: number;       // 锁的超时时间
  retryMs: number;     // 重试间隔
  maxRetries: number;  // 最大重试次数
}

interface LockEntry {
  owner: string;
  acquiredAt: number;
  ttlMs: number;
}

class DistributedLockManager {
  private locks = new Map<string, LockEntry>();
  private timers = new Map<string, NodeJS.Timeout>();

  // BUG 1 (严重): acquire 返回 boolean 但 async 函数应返回 Promise<boolean>
  // 且重试逻辑有 off-by-one: maxRetries=3 实际只重试 2 次
  async acquire(
    key: string,
    owner: string,
    options: LockOptions = { ttlMs: 30000, retryMs: 1000, maxRetries: 3 }
  ): Promise<boolean> {
    for (let i = 0; i < options.maxRetries; i++) {
      const existing = this.locks.get(key);

      // BUG 2 (严重): 过期判断条件反了，应该是 now - acquiredAt > ttlMs
      if (existing && Date.now() - existing.acquiredAt < existing.ttlMs) {
        this.locks.delete(key);
      }

      if (!this.locks.has(key)) {
        this.locks.set(key, { owner, acquiredAt: Date.now(), ttlMs: options.ttlMs });

        // BUG 3 (中等): 定时器用 key 而不是 owner+key，多个 owner 竞争同一 key 时定时器会被覆盖
        this.timers.set(key, setTimeout(() => {
          this.locks.delete(key);
          this.timers.delete(key);
        }, options.ttlMs));

        return true;
      }

      // BUG 4 (严重): await 了一个没有 resolve 的 Promise 构造
      // 正确写法应该是 new Promise(resolve => setTimeout(resolve, options.retryMs))
      await new Promise(setTimeout(options.retryMs));
    }
    return false;
  }

  // BUG 5 (中等): release 没有检查 owner，任何人都能释放任何锁
  release(key: string): boolean {
    const existing = this.locks.get(key);
    if (!existing) return false;

    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);

    this.locks.delete(key);
    this.timers.delete(key);
    return true;
  }

  // BUG 6 (低危): isLocked 没有检查过期，可能返回过期锁的状态
  isLocked(key: string): boolean {
    return this.locks.has(key);
  }

  // 获取锁信息
  getLockInfo(key: string): LockEntry | undefined {
    return this.locks.get(key);
  }
}
```

**考察点（对应 profiler 维度：review）：**
- 能否找全 6 个 bug（不多找不少找）
- 严重程度判断是否准确
- 修复代码是否正确且不引入新 bug
- 生产后果分析是否到位（如"死锁""锁泄漏""安全漏洞"等关键词）

**评分细则：**

| 分数 | 标准 |
|------|------|
| 9-10 | 6/6 全部找到，严重程度分类准确，修复代码正确，后果分析深入 |
| 7-8 | 找到 5 个，或全找到但修复代码有小瑕疵 |
| 5-6 | 找到 4 个，或误报 >= 2 个不存在的 bug |
| 3-4 | 只找到 2-3 个严重 bug，遗漏关键问题 |
| 1-2 | 找到 <= 1 个或大量误报 |

---

## TASK3: Spec Adherence — 在矛盾约束中做正确决策

```
你需要为一个 API 网关实现请求路由模块。以下是三份文档，按优先级排列：

【文档 A — 最高优先级：ERRATA 勘误】
- 路由匹配优先级应为：精确匹配 > 参数路由 > 通配符路由（覆盖文档 B 中的错误描述）
- 超时时间单位统一为毫秒（文档 C 中的"秒"为笔误）
- 404 响应体必须包含 { error: string, path: string }（文档 C 遗漏了 path 字段）

【文档 B — 中等优先级：设计规格】
- 路由表结构：Map<string, RouteConfig>
- RouteConfig: { handler: string, timeout: number, middleware: string[] }
- 路由匹配优先级：通配符 > 参数路由 > 精确匹配（注意：这与 ERRATA 矛盾）
- 支持路径参数：/users/:id 匹配 /users/123
- 支持通配符：/api/* 匹配 /api/任意路径

【文档 C — 最低优先级：实现指南】
- 超时默认值为 30（单位：秒）（注意：ERRATA 说单位是毫秒）
- 超时检测使用 setTimeout
- 404 响应体格式：{ error: "Not Found" }（注意：ERRATA 要求增加 path 字段）
- 所有路由处理函数签名：(req: Request) => Promise<Response>

请实现这个路由模块：
1. 正确处理三份文档的优先级冲突
2. 在代码注释中标注每个冲突点你选择了哪份文档的版本以及原因
3. 实现完整的路由匹配（精确、参数、通配符）
4. 包含 3 个测试用例验证优先级正确性
```

**考察点（对应 profiler 维度：spec_adherence + scope_discipline）：**
- 是否正确识别 3 处文档冲突
- 是否按优先级（A > B > C）解决冲突
- 是否在代码中明确标注冲突解决决策
- 路由匹配实现是否正确（精确 > 参数 > 通配符）
- 超时单位是否用毫秒（30000ms，不是 30s）
- 404 响应体是否包含 path 字段

**评分细则：**

| 分数 | 标准 |
|------|------|
| 9-10 | 3/3 冲突全部正确解决，代码注释清晰标注决策，路由实现正确，测试覆盖优先级 |
| 7-8 | 冲突基本解决但注释不充分，或路由实现有小瑕疵 |
| 5-6 | 遗漏 1 个冲突，或按错误优先级实现 |
| 3-4 | 遗漏 2+ 个冲突，或直接忽略文档优先级 |
| 1-2 | 完全无视文档冲突，按单一文档实现 |

---

## TASK4: Repair — 根据 Review 反馈修复代码

```
你是一个 worker，在第一轮实现了以下 ConnectionPool 模块。
现在收到了 reviewer 的反馈，请按要求修复。

【你的第一轮代码】:

class ConnectionPool<T> {
  private pool: T[] = [];
  private inUse = new Set<T>();
  private maxSize: number;
  private factory: () => Promise<T>;

  constructor(factory: () => Promise<T>, maxSize: number = 10) {
    this.factory = factory;
    this.maxSize = maxSize;
  }

  async acquire(): Promise<T> {
    // 从池中取一个空闲连接
    if (this.pool.length > 0) {
      const conn = this.pool.pop()!;
      this.inUse.add(conn);
      return conn;
    }
    // 池空但未达上限，创建新连接
    if (this.inUse.size < this.maxSize) {
      const conn = await this.factory();
      this.inUse.add(conn);
      return conn;
    }
    // 达到上限，抛异常
    throw new Error('Pool exhausted');
  }

  release(conn: T): void {
    this.inUse.delete(conn);
    this.pool.push(conn);
  }

  async drain(): Promise<void> {
    this.pool = [];
    this.inUse.clear();
  }
}

【Reviewer 反馈（共 4 项 finding）】:

1. [RED] acquire() 达到上限时直接抛异常不合理。应该实现等待队列：
   当池耗尽时，acquire() 返回一个 Promise 挂起等待，release() 时唤醒队首等待者。

2. [YELLOW] release() 没有验证 conn 是否属于 inUse。如果用户 release 一个
   不属于池的连接，会污染连接池。需要加 inUse.has(conn) 检查。

3. [YELLOW] drain() 没有等待 inUse 中的连接完成。应该等所有连接归还后再清空，
   或者至少提供 force 参数选项。

4. [RED] 缺少健康检查：长期闲置的连接可能已断开。acquire 从池中取出连接前
   应支持可选的 validate 函数验证连接有效性。

请修复以上 4 项 finding。要求：
- 只修复反馈中提到的问题，不要做额外重构
- 保持现有 API 的向后兼容性
- 每项修复用注释标注对应的 finding 编号
- 给出修复后的完整代码 + 4 个测试用例（每项 finding 各一个）
```

**考察点（对应 profiler 维度：repair + scope_discipline）：**
- 4 项 finding 是否全部正确修复
- 等待队列实现是否正确（Promise resolve 链）
- 是否保持 API 向后兼容（不破坏现有签名）
- 是否只修了要求的内容（不做额外"改进"）
- 修复注释是否标注 finding 编号
- drain 的 force 模式是否合理

**评分细则：**

| 分数 | 标准 |
|------|------|
| 9-10 | 4/4 全部正确修复，API 向后兼容，注释标注清晰，测试覆盖每项修复，无越界改动 |
| 7-8 | 修复正确但有小瑕疵（如等待队列的 edge case），或测试不完整 |
| 5-6 | 修复了 3 项但遗漏 1 项，或引入了新 bug |
| 3-4 | 只修复了 2 项，或做了大量越界重构 |
| 1-2 | 修复不足 2 项或重写了整个类 |

---

## TASK5: Translation — 中英日三语技术翻译（基线对比）

```
将以下技术段落翻译为英文，然后翻译为日文，最后再将英文版翻译回中文。保持技术术语的一致性。

原文：
"在事件驱动架构（EDA）中，CQRS 模式将读写操作分离到不同的模型中处理。
命令端（Command Side）通过事件溯源（Event Sourcing）记录所有状态变更，
查询端（Query Side）则维护物化视图（Materialized View）以优化读取性能。
最终一致性（Eventual Consistency）是这种架构的核心特征——
写入确认后，读取端可能需要数毫秒到数秒的延迟才能反映最新状态。
补偿事务（Compensating Transaction）用于处理分布式场景下的业务回滚。"
```

**考察点（对应 profiler 维度：translation 基线）：**
- CQRS / Event Sourcing / Materialized View / Eventual Consistency / Compensating Transaction 术语一致性
- 日文片假名使用（不混入中文汉字）
- 回译还原度

**评分细则：**

| 分数 | 标准 |
|------|------|
| 9-10 | 三语翻译准确流畅，术语一致，回译高度还原 |
| 7-8 | 基本准确但有小瑕疵 |
| 5-6 | 有明显翻译错误但整体可理解 |
| 3-4 | 日文混入中文或严重误译 |
| 1-2 | 翻译不可用 |

---

## 评分汇总表模板

| 排名 | 模型 | TASK1 Implementation | TASK2 Review | TASK3 Spec | TASK4 Repair | TASK5 Translation | **总分** |
|------|------|---------------------|-------------|-----------|-------------|-------------------|---------|
| | | /10 | /10 | /10 | /10 | /10 | /50 |

### Profiler 维度映射

| TASK | 对应 ProfileScoreKey | 权重建议 |
|------|---------------------|---------|
| TASK1 | implementation | 主要 |
| TASK2 | review | 主要 |
| TASK3 | spec_adherence + scope_discipline | 主要 + 辅助 |
| TASK4 | repair + scope_discipline | 主要 + 辅助 |
| TASK5 | translation (static score) | 基线 |

### scorecard 映射公式

```
spec_comprehension = TASK3 × 2           (满分 20)
delivery_completeness = TASK1 × 1.5      (满分 15)
code_control = (TASK1 + TASK4) × 1.0     (满分 20)
scope_discipline = (TASK3_scope + TASK4_scope) × 0.5  (满分 10)
integration_readiness = TASK3 × 1.5      (满分 15)
repair_ability = TASK4                    (满分 10)
turnaround_speed = 相对时间              (满分 10)
```
