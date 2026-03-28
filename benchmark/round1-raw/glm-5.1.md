# glm-5.1 完整答卷 — Round 1

## 响应元数据
- 模型: glm-5.1
- Task ID: glm51-r1
- 响应时间: 102748ms (103s)
- Token: input=699, output=3199
- 状态: success

---

## TASK1: Coding

```typescript
/**
 * 泛型 LRU Cache 实现
 * 使用 Map 来保证 O(1) 的时间复杂度，利用 Map 迭代器的插入顺序特性来维护 LRU 状态
 */
class LRUCache<K, V> {
  private readonly capacity: number;
  private cache: Map<K, V>;

  /**
   * @param capacity 缓存容量，必须大于 0
   */
  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new Error("Capacity must be greater than 0");
    }
    this.capacity = capacity;
    this.cache = new Map<K, V>();
  }

  /**
   * 获取缓存值，如果存在则将其移到最近使用的位置
   * 时间复杂度: O(1)
   */
  get(key: K): V | undefined {
    if (!this.cache.has(key)) {
      return undefined;
    }
    // 删除并重新插入以更新其在 Map 迭代器中的顺序至末尾（最近使用）
    const value = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  /**
   * 更新缓存值，如果存在则更新并移到最近使用的位置
   * 时间复杂度: O(1)
   */
  put(key: K, value: V): void {
    // 如果 key 已存在，先删除以重置顺序
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    // 如果达到容量上限，淘汰最久未使用的项（Map 迭代器的第一项）
    else if (this.cache.size >= this.capacity) {
      const lruKey = this.cache.keys().next().value;
      if (lruKey !== undefined) {
        this.cache.delete(lruKey);
      }
    }
    this.cache.set(key, value);
  }

  /**
   * 删除指定 key
   * 时间复杂度: O(1)
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
  }
}

// ==========================================
// 测试代码与边界用例
// ==========================================

// 边界用例 1: 容量溢出时的正确淘汰
console.log("--- Test Case 1: Capacity Eviction ---");
const cache1 = new LRUCache<string, number>(3);
cache1.put("a", 1);
cache1.put("b", 2);
cache1.put("c", 3);
// 此时 cache 为 a, b, c。容量已满
cache1.put("d", 4);
// a 成为最久未使用，应被淘汰
console.log(cache1.get("a")); // 期望输出: undefined
console.log(cache1.get("b")); // 期望输出: 2 (此时 b 变为最近使用，顺序变为 c, d, b)

// 边界用例 2: 负数或零容量异常处理
console.log("--- Test Case 2: Invalid Capacity ---");
try {
  const cache2 = new LRUCache<number, string>(0);
} catch (error: any) {
  console.log(error.message); // 期望输出: Capacity must be greater than 0
}

// 边界用例 3: 删除操作后，新元素应正确填入空缺且不影响其他元素的 LRU 状态
console.log("--- Test Case 3: Delete and Reinsert ---");
const cache3 = new LRUCache<number, string>(2);
cache3.put(1, "x");
cache3.put(2, "y");
cache3.delete(1); // 删除 1，此时 cache 只有 2
cache3.put(3, "z"); // 加入 3，不需要淘汰，此时 cache 为 2, 3
console.log(cache3.get(2)); // 期望输出: "y" (顺序更新为 3, 2)
cache3.put(4, "w"); // 加入 4，应淘汰 3
console.log(cache3.get(3)); // 期望输出: undefined
console.log(cache3.get(2)); // 期望输出: "y"
```

## TASK2: Reasoning

**推理过程：**

1. **确定基准效率关系：**
   设 C 线的基础产能效率为 $x$（件/小时）。
   - B 线效率是 C 线的 2 倍：$B = 2x$
   - A 线效率是 B 线的 1.5 倍：$A = 1.5 \times 2x = 3x$

2. **计算理论总产能：**
   题目指出其余时间（每天按 8 小时计）三条线同时满载运行，且每天总产能为 1000 件。由于有停机时间，这里的"每天总产能 1000 件"指的是**有停机情况下的当前实际总产量**。
   - A 线每天实际运行时间：$8 - 2 = 6$ 小时
   - B 线每天实际运行时间：$8 - 1 = 7$ 小时
   - C 线每天实际运行时间：$8 - 0 = 8$ 小时

   实际总产量计算：
   $(A \times 6) + (B \times 7) + (C \times 8) = 1000$
   $(3x \times 6) + (2x \times 7) + (x \times 8) = 1000$
   $18x + 14x + 8x = 1000$
   $40x = 1000$
   解得基准效率：$x = 25$ 件/小时。

**解答问题：**

**1. 每条生产线每小时的产能各是多少？**
   - **A 线产能**：$3x = 3 \times 25 = 75$ 件/小时
   - **B 线产能**：$2x = 2 \times 25 = 50$ 件/小时
   - **C 线产能**：$x = 25$ 件/小时

**2. 一天实际总产量是多少？**
   根据题意和计算，当前一天的实际总产量为 **1000 件**。

**3. 如果取消 A 线的维护停机，日产量增加多少百分比？**
   - 取消 A 线停机后，A 线每天运行 8 小时，增加的运行时间为 2 小时。
   - A 线增加的产量：$75 \text{ 件/小时} \times 2 \text{ 小时} = 150 \text{ 件}$
   - 新的日产量：$1000 + 150 = 1150 \text{ 件}$
   - 增加的百分比：$\frac{1150 - 1000}{1000} = 0.15$，即 **15%**。

## TASK3: Translation

**English Translation:**
In a microservices architecture, a Service Mesh achieves traffic management, service discovery, and load balancing through sidecar proxies. As the most popular Service Mesh implementation, Istio's data plane consists of Envoy proxies, while its control plane is responsible for configuration distribution and certificate management. Blue-green deployment and canary release are common release strategies within a Service Mesh, and combined with Traffic Mirroring, they can enable zero-risk version switching.

**Japanese Translation (日本語翻訳):**
マイクロサービスアーキテクチャにおいて、Service Meshはsidecarプロキシを通じてトラフィック管理、サービスディスカバリ、および負荷分散を実現します。最も人気のあるService Meshの実装であるIstioは、そのデータプレーンがEnvoyプロキシで構成されており、コントロールプレーンは設定の配信と証明書の管理を担当します。ブルーグリーンデプロイメントとカナリアリリースはService Meshにおける一般的なリリース戦略であり、Traffic Mirroringと組み合わせることで、ゼロリスクでのバージョン切り替えを実現できます。

**Chinese Back-Translation (回译中文):**
在微服务架构中，服务网格通过 sidecar 代理实现流量管理、服务发现和负载均衡。作为最受欢迎的服务网格实现，Istio 的数据平面由 Envoy 代理组成，而其控制平面负责配置分发和证书管理。蓝绿部署和金丝雀发布是服务网格中常见的发布策略，配合流量镜像，可以实现零风险的版本切换。

## TASK4: Analysis

针对日活 1000 万的社交平台，现设计一套高可用、易扩展的分布式即时消息系统架构。

#### 1. 整体架构描述

系统架构分层如下：

*   **接入层:**
    部署长连接网关集群，负责维护客户端的 WebSocket 长连接。通过负载均衡（如 Nginx 或云 LB）分发流量。网关无状态化，节点故障不影响全局。
*   **逻辑层:**
    处理 IM 核心业务逻辑（如消息发送、ACK 确认、会话管理、好友关系校验）。
*   **核心中间件:**
    *   **消息队列:** 采用 RocketMQ 或 Kafka，作为消息的持久化缓冲区，利用其极高的吞吐量解决流量洪峰问题。
    *   **分布式 KV (Redis Cluster):** 替换原有单体 Redis，存储用户会话状态、路由信息（记录用户当前连接的网关节点）以及离线消息计数。
*   **存储层:**
    *   **消息库:** 分布式海量存储（如 Cassandra 或 HBase），支持高并发写入。或使用分库分表的 MySQL。
    *   **关系库:** MySQL 存储用户资料、好友列表等核心关系数据。

**数据流向：**
用户 A 发送消息 -> Gateway -> Logic Server -> MQ -> Logic Server -> 存入 DB -> 查找用户 B 在线状态 -> 投递至 B 所在的 Gateway -> 推送至 B 客户端。

#### 2. 消息投递的可靠性保证策略

*   **离线消息处理：**
    用户上线时，客户端携带本地最新消息的 ID（或时间戳）请求拉取。服务端从 Redis（近期离线消息）和 DB（较久远离线消息）中拉取差异数据下发给客户端。
*   **消息不丢失（可靠投递机制）：**
    采用 **"发送端 ACK + 服务端去重 + 接收端 ACK"** 机制。
    1. 发送端发出消息，服务端收到后先落盘 MQ 并返回 `Recv_ACK`。
    2. 接收端收到消息后，返回 `Read_ACK` 给服务端。
    3. 如果发送端未收到 `Recv_ACK`，会带上消息唯一 ID（如 MD5(timestamp+content)）进行重发。
*   **消息不重复（幂等性）：**
    每条消息服务端会生成全局唯一的 `Message ID`。接收端网关维护一个短期的去重 Bloom Filter 或 LRU Cache，如果发现重复的 `Message ID` 则直接丢弃，确保客户端 UI 层不会出现重复消息。

#### 3. 与现有系统的平滑迁移方案（零停机）

1.  **双写阶段：** 新 IM 系统与单体应用并行运行。客户端同时建立新旧两个连接（或仅旧连接负责收发，新连接静默同步数据）。所有发往旧系统的消息，在底层数据库层面同步双写到新的 MQ 和新存储库中。
2.  **灰度切流：** 开启灰度白名单，针对 1% 的用户，将新安装或重启的客户端的连接配置指向新的分布式网关。新客户端通过新系统收发，旧客户端继续走旧系统。
3.  **全量迁移：** 逐步扩大比例（10% -> 50% -> 100%）。旧系统的 Redis Pub/Sub 降级为仅接收未升级用户的流量。
4.  **下线旧系统：** 强制客户端升级，待所有用户升级完毕且旧系统无流量后，关闭单体应用。

#### 4. 性能指标估算

*   **并发在线预估：**
    假设日活(DAU) 1000 万，通常并发比约为 10% - 20%，则最大并发连接数约为 150 万。单台长连接网关支撑约 10 万连接，需要约 **15-20 台网关机器**。
*   **QPS 估算：**
    假设平均每人每天发送 50 条消息，高峰期通常是均值的 5 倍。
    总日消息量：10,000,000 * 50 = 5 亿条。
    平均 TPS：500,000,000 / (86400) ≈ 5700。
    **峰值 QPS**：5700 * 5 ≈ **28,500 QPS**（依靠 MQ 削峰，数据库只需跟得上平均写入速率即可轻松应对）。
*   **延迟：**
    纯网关转发和 MQ 路由的网络延迟约在 **5ms - 15ms** 内。同城/异地多活部署下，端到端消息延迟可控制在 **50ms** 以内。

#### 5. 方案的潜在风险和应对措施

*   **风险1：网关集群节点宕机导致大批连接断开。**
    *   *应对措施：* 客户端设计指数退避重连机制；采用一致性哈希路由，宕机时只有部分连接断开且负载能快速被其他节点平滑接管；网关实现会话保持快速恢复。
*   **风险2：消息激增打爆 MQ 或存储。**
    *   *应对措施：* 对消息系统实施限流（令牌桶算法），保护后端数据库；MQ 配置海量积压能力，确保系统不被瞬时的脉冲流量击垮。
*   **风险3：迁移过程中旧版本客户端消息互通失败。**
    *   *应对措施：* 在双写阶段，建立跨系统的消息同步通道（旧系统若收到旧版客户端消息，通过 HTTP/RPC 转发至新系统确保新版客户端能收到，反之亦然）。
