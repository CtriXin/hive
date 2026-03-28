# glm-5.1 完整答卷 — Round 2

## 响应元数据
- 模型: glm-5.1
- Task ID: glm51-r2
- 响应时间: 115298ms (115s)
- Token: input=807, output=3863
- 状态: success

---

## TASK1: Coding

```typescript
/**
 * 类型安全的泛型 EventBus
 */
export type EventWildcard = '*';
export type EventKey = string | EventWildcard;

// 支持严格的事件映射，也可以直接用字符串
export interface GenericEventMap {
  [key: string]: any;
}

export class EventBus<TEventMap extends GenericEventMap = GenericEventMap> {
  private listeners: Map<EventKey, Array<(data: any) => void>> = new Map();

  /**
   * 监听事件，支持通配符 (如 'user.*')
   */
  public on<K extends keyof TEventMap & string>(
    event: K | `${string}.${string}`,
    handler: (data: TEventMap[K]) => void
  ): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(handler);
  }

  /**
   * 监听一次，触发后自动解绑
   */
  public once<K extends keyof TEventMap & string>(
    event: K | `${string}.${string}`,
    handler: (data: TEventMap[K]) => void
  ): void {
    const wrapper = (data: TEventMap[K]) => {
      handler(data);
      this.off(event, wrapper);
    };
    this.on(event, wrapper);
  }

  /**
   * 取消监听
   */
  public off<K extends keyof TEventMap & string>(
    event: K | `${string}.${string}`,
    handler: (data: TEventMap[K]) => void
  ): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;

    const index = handlers.indexOf(handler);
    if (index > -1) {
      handlers.splice(index, 1);
    }
    if (handlers.length === 0) {
      this.listeners.delete(event);
    }
  }

  /**
   * 触发事件，同时触发对应的通配符监听器
   */
  public emit<K extends keyof TEventMap & string>(event: K, data: TEventMap[K]): void {
    // 1. 触发精确匹配的监听器
    const exactHandlers = this.listeners.get(event);
    if (exactHandlers) {
      exactHandlers.forEach((handler) => handler(data));
    }

    // 2. 检查并触发通配符监听器
    const parts = event.split('.');
    const wildcardEvents = Array.from(this.listeners.keys()).filter((key) => {
      if (typeof key !== 'string' || !key.includes('*')) return false;
      const keyParts = key.split('.');
      if (keyParts.length !== parts.length) return false;
      return keyParts.every((kp, i) => kp === '*' || kp === parts[i]);
    });

    wildcardEvents.forEach((wcEvent) => {
      const wcHandlers = this.listeners.get(wcEvent);
      if (wcHandlers) {
        wcHandlers.forEach((handler) => handler(data));
      }
    });
  }
}

// ==========================================
// 测试代码（包含边界用例）
// ==========================================

interface MyEvents {
  'user.login': { id: string };
  'user.logout': { id: string };
  'order.create': { orderId: string };
}

const bus = new EventBus<MyEvents>();

console.log('--- Test Case 1: Wildcard matching ---');
const wildcardHandler = (data: any) => console.log('Wildcard triggered:', data.id);
bus.on('user.*', wildcardHandler);
console.log('Emit user.login:');
bus.emit('user.login', { id: 'user_1' }); // 期望输出: Wildcard triggered: user_1
console.log('Emit user.logout:');
bus.emit('user.logout', { id: 'user_2' }); // 期望输出: Wildcard triggered: user_2
console.log('Emit order.create:');
bus.emit('order.create', { orderId: 'order_1' }); // 期望无输出，不匹配 'user.*'

console.log('\n--- Test Case 2: Once ---');
const onceHandler = (data: any) => console.log('Once handler triggered:', data.id);
bus.once('user.login', onceHandler);
console.log('First emit:');
bus.emit('user.login', { id: 'user_3' }); // 期望输出: Once handler triggered: user_3 及 Wildcard
console.log('Second emit:');
bus.emit('user.login', { id: 'user_4' }); // 期望 Once handler 无输出，仅 Wildcatd 输出

console.log('\n--- Test Case 3: Off no longer triggers ---');
console.log('Removing wildcard handler...');
bus.off('user.*', wildcardHandler);
console.log('Emit user.login after off:');
bus.emit('user.login', { id: 'user_5' }); // 期望完全无输出

console.log('\n--- Test Case 4: Emit non-existing event ---');
// 类型系统会警告，但如果强制触发未注册的事件，不应报错
console.log('Emitting non-existing event gracefully...');
bus.emit('order.create', { orderId: 'order_2' }); // 期望无输出且无运行时报错
```

## TASK2: Reasoning

根据容量适应和时间不冲突的原则，安排结果如下：

**1. 产品评审会：9:00-11:00，6人参加**
*   **分配房间：** 会议室 A (6人)
*   **理由：** 参会人数刚好为6人，完美匹配会议室A的容量。遵循不浪费大容量资源的原则。

**2. 技术讨论会：9:30-11:00，5人参加**
*   **分配房间：** 会议室 A (6人) - *重新调整*
*   **说明：** 这里有时间上的重叠（9:30-11:00）。由于会议室A已经被6人的产品评审会占用，必须分配更大的房间。
*   **重新分配：** 会议室 B (8人)
*   **理由：** 5人无法放入6人的A（因为A已被占用），最小的可用合适房间为B。

**3. 架构评审会：14:00-16:00，8人参加**
*   **分配房间：** 会议室 B (8人)
*   **理由：** 刚好满足8人，且下午14:00-16:00期间该房间空闲。

**4. 客户演示会：14:00-15:00，15人参加**
*   **分配房间：** 会议室 E (20人)
*   **理由：** 15人参加，只有会议室D(12人)和E(20人)能容纳。因为D只有12人无法容纳15人，所以必须分配最大的会议室E。

**5. Sprint回顾会：15:00-17:00，8人参加**
*   **分配房间：** 会议室 B (8人) - *冲突检查*
*   **重新分配：** 会议室 C (10人)
*   **理由：** 会议室B在14:00-16:00被架构评审会占用，与15:00-17:00有时间重叠（15:00-16:00冲突）。因此向上取最近的空闲会议室C(10人)。时间段15:00-17:00期间C空闲。

**6. 全员站会：16:00-16:30，18人参加**
*   **分配房间：** 会议室 E (20人)
*   **理由：** 需要18人，只有会议室E(20人)能容纳。此时客户演示会（14:00-15:00）已经结束，会议室E处于空闲状态，可以直接使用。

**总结表：**

| 会议名称 | 时间 | 人数 | 分配房间 | 备注 |
| :--- | :--- | :--- | :--- | :--- |
| 产品评审会 | 09:00-11:00 | 6 | A (6人) | 完美匹配容量 |
| 技术讨论会 | 09:30-11:00 | 5 | B (8人) | A已被占用，选最小可用 |
| 架构评审会 | 14:00-16:00 | 8 | B (8人) | 完美匹配容量 |
| 客户演示会 | 14:00-15:00 | 15 | E (20人) | D容量不足，必须用E |
| Sprint回顾会| 15:00-17:00 | 8 | C (10人) | B被架构会议占用，选C |
| 全员站会 | 16:00-16:30 | 18 | E (20人) | 客户演示已结束，复用E |

## TASK3: Translation

**【英文翻译】**
"In a microservices architecture, distributed transactions are the core challenge in ensuring data consistency. Common solutions include the Saga pattern, the TCC (Try-Confirm-Cancel) pattern, and the Seata AT pattern.
The Saga pattern achieves eventual consistency by splitting a long transaction into multiple local transactions; once each local transaction completes, it publishes an event to trigger the next transaction.
The TCC pattern requires each participant to implement three operations: the Try phase reserves resources, the Confirm phase confirms the commit, and the Cancel phase rolls back and releases resources.
The Seata AT pattern is a non-intrusive solution that automatically generates rollback logs (undo_log) by intercepting SQL, meaning developers do not need to write compensation logic."

**【日文翻译】**
「マイクロサービスアーキテクチャにおいて、分散トランザクションはデータ整合性を保証するための中核的な課題です。一般的なソリューションには、Sagaパターン、TCC（Try-Confirm-Cancel）パターン、およびSeata ATパターンが含まれます。
Sagaパターンは、長いトランザクションを複数のローカルトランザクションに分割することにより、結果整合性を実現します。各ローカルトランザクションの実行完了後、イベントを発行して次のトランザクションをトリガーします。
TCCパターンは、各参加者が3つの操作を実装することを要求します：Tryフェーズでリソースを予約し、Confirmフェーズでコミットを確認し、Cancelフェーズでロールバックしてリソースを解放します。
Seata ATパターンは非侵入型のソリューションであり、SQLをインターセプトすることで自動的にロールバックログ（undo_log）を生成するため、開発者は補償ロジックを記述する必要がありません。」

**【回译中文】**
"在微服务架构中，分布式事务是确保数据一致性的核心挑战。常见的解决方案包括 Saga 模式、TCC（Try-Confirm-Cancel）模式以及 Seata AT 模式。
Saga 模式通过将长事务拆分为多个本地事务来实现最终一致性；每个本地事务执行完成后，它会发布一个事件以触发下一个事务。
TCC 模式要求每个参与者实现三个操作：Try 阶段预留资源，Confirm 阶段确认提交，Cancel 阶段回滚并释放资源。
Seata AT 模式是一种无侵入的解决方案，它通过拦截 SQL 自动生成回滚日志（undo_log），这意味着开发人员无需编写补偿逻辑。"

## TASK4: Analysis

#### 1. 整体架构图 (ASCII)

```text
[客户端]
   |
   v (1. 发起重定向/点击)
[Web 应用层 / 负载均衡 (Nginx/ALB)]
   |
   +--> [WAF & 安全网关 ] --> (防刷、黑名单检测)
   |
   v (2. 路由分发)
[API 服务集群 (Shortener API)]
   |-- (写入) --> [消息队列 ] --异步--> [短链生成 Worker]
   |                                                |
   |                                                v
   |                                          [MySQL (关系型DB)]
   |                                                |
   |                                                +--(Change Data Capture / Binlog订阅)--> [Flink / Spark]
   |                                                                                      |
   |                                                                                      v
   |                                                                           [数据仓库 / OLAP引擎 (ClickHouse)]
   |
   |-- (读取) --> [Redis 缓存集群] (Lua 莎士比亚/布隆过滤器防穿透)
   |
   v (3. 302 重定向)
[目标长链接 URL]
```

#### 2. 短链接生成算法选型

| 方案 | 描述 | 优点 | 缺点 | 适用场景 |
| :--- | :--- | :--- | :--- | :--- |
| **方案一: MD5/SHA256 哈希** | 对长链加盐并哈希，取前6-8位。 | 生成快，实现简单。 | 容易哈希碰撞，需查库校验；无法防止逆向推算。 | 传统短链，对安全性要求不高。 |
| **方案二: 数据库自增ID** | 利用数据库 `AUTO_INCREMENT`，通过 Base62 转换为短链。 | 绝对无碰撞，无依赖。 | 数据库容易成为写入瓶颈；ID连续容易被爬虫遍历。 | 并发写入不高的内部系统。 |
| **方案三: 雪花算法 + Base62** | 使用分布式唯一ID生成器，转 Base62/Radix62。 | 无碰撞，高性能，无中心化依赖。 | 生成的串可能较长（需优化雪花位分配）。 | **推荐方案**。高并发分布式架构。 |
| **方案四: 随机数 + 布隆过滤** | 随机生成6位字符串，查库/查布隆过滤器判断是否存在。 | 无规律，安全性高。 | 存在碰撞重试风险，随着数据量增大效率降低。 | 长度要求极度严格的自定义短链。 |

**最终选型推荐**：**雪花算法 + Base62 转换**。对于自定义别名，直接将用户自定义别名作为 Hash Key 存储在数据库中。

#### 3. 高并发读取方案

短链服务的读写比例通常极高（如 1000:1），必须针对读取进行深度优化：

1.  **多级缓存架构**：
    *   **本地缓存 (Caffeine/Guava Cache)**：在 API 实例本地缓存热点短链（如秒杀活动短链），抗住极端峰值，避免 Redis 热点 Key 问题。
    *   **分布式缓存**：使用 Redis Cluster 存储全量活跃短链映射。
2.  **缓存穿透保护**：
    *   对于不存在的短链，使用 **布隆过滤器** 或缓存空值（设置极短TTL，如30秒），防止恶意请求直接穿透到数据库。
3.  **缓存击穿保护**：
    *   热点 Key 过期时，使用分布式锁或者逻辑过期机制，确保只有一个线程去重构缓存，其他线程等待或直接返回旧数据。
4.  **动静分离与边缘计算**：
    *   对于大量的 302 重定向请求，可以推送到 CDN 边缘节点或使用 Cloudflare Workers 进行边缘重定向，将流量拦截在数据中心之外。

#### 4. 分析管道设计

为了支持日活 500 万且峰值极高的数据分析，必须采用**异步流处理架构**，严禁在主链路同步写统计数据库。

1.  **数据采集**：
    *   客户端发起请求时，API 服务只做最轻量的日志打印（包含短链、IP、User-Agent、Referer等），或者将解析后的基本信息推送到消息队列。
2.  **消息中间件**：
    *   使用 Kafka 存储原始点击流数据，起到削峰填谷的作用。
3.  **流式计算**：
    *   使用 Apache Flink 消费 Kafka 数据。在内存中进行窗口计算（Window Aggregation），按分钟/小时/天聚合 PV、UV（通过 HyperLogLog）、地域分布（通过 MaxMind 解析 IP）。
4.  **数据存储与展示**：
    *   **热数据**：聚合后的实时数据写入 Redis，供 API 接口实时查询大盘。
    *   **冷数据/明细数据**：Flink 将聚合结果和部分明细数据写入 ClickHouse（OLAP引擎），利用其向量化计算能力快速产出多维度的分析报表。

#### 5. 安全防护措施

1.  **防滥用/防刷 (Rate Limiting)**：
    *   **API 层面**：对创建短链的接口进行严格的频率限制（如单IP单用户每分钟限制10次创建）。
    *   **读取层面**：对异常高频访问同一短链的 IP/设备进行限速或验证码拦截（WAF规则）。
2.  **防恶意链接 (Anti-Malware)**：
    *   在创建短链时，集成第三方的网址安全检测服务（如 Google Safe Browsing, VirusTotal），拒绝将钓鱼、挂马网站转化为短链。
    *   定期异步扫描数据库中已存在的长链，发现恶意链接主动封禁。
3.  **敏感信息保护**：
    *   在重定向前增加过渡页面（警告页面），提示用户即将离开当前平台前往第三方链接，特别是对于识别为高危的链接。
4.  **自定义别名风控**：
    *   限制自定义别名的长度和字符集。
    *   建立敏感词库过滤，防止生成涉黄、涉政等违规自定义短链。
    *   防止抢注系统内部保留字（如 `admin`, `api`, `help`）。
