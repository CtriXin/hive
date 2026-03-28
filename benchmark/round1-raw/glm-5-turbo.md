# glm-5-turbo 完整答卷 — Round 1

## 响应元数据
- 模型: glm-5-turbo
- Task ID: eval-glm5turbo
- 响应时间: 102025ms
- Token: input=671, output=3598
- 状态: success

---

## TASK1: Coding

```typescript
class LRUCache<K, V> {
  private capacity: number;
  private cache: Map<K, V>;

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error("Capacity must be greater than 0");
    this.capacity = capacity;
    this.cache = new Map<K, V>();
  }

  get(key: K): V | undefined {
    if (!this.cache.has(key)) {
      return undefined;
    }
    const value = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  put(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  getSize(): number {
    return this.cache.size;
  }
}

function runTests() {
  console.log("Test 1: 基本 LRU 淘汰逻辑");
  const cache1 = new LRUCache<number, string>(2);
  cache1.put(1, "One");
  cache1.put(2, "Two");
  cache1.put(3, "Three");
  console.log(cache1.get(1) === undefined ? "Pass: 1被淘汰" : "Fail: 1未被淘汰");
  console.log(cache1.get(2) === "Two" ? "Pass: 2存在" : "Fail: 2异常");
  console.log(cache1.get(3) === "Three" ? "Pass: 3存在" : "Fail: 3异常");

  console.log("\nTest 2: 边界用例 - 容量为 1");
  const cache2 = new LRUCache<string, number>(1);
  cache2.put("a", 1);
  cache2.put("b", 2);
  console.log(cache2.get("a") === undefined ? "Pass: a被淘汰" : "Fail: a未被淘汰");
  console.log(cache2.get("b") === 2 ? "Pass: b存在" : "Fail: b异常");

  console.log("\nTest 3: 边界用例 - 更新已存在的 Key 会刷新其 LRU 顺序");
  const cache3 = new LRUCache<number, number>(3);
  cache3.put(1, 100);
  cache3.put(2, 200);
  cache3.put(3, 300);
  cache3.get(1);
  cache3.put(4, 400);
  console.log(cache3.get(2) === undefined ? "Pass: 2被淘汰" : "Fail: 2未被淘汰");
  console.log(cache3.get(1) === 100 ? "Pass: 1依然存在" : "Fail: 1异常");

  console.log("\nTest 4: 边界用例 - delete 和 clear 方法");
  const cache4 = new LRUCache<string, string>(3);
  cache4.put("x", "X");
  cache4.put("y", "Y");
  cache4.put("z", "Z");
  const deleted = cache4.delete("y");
  console.log(deleted === true ? "Pass: 删除成功返回true" : "Fail: 删除返回异常");
  console.log(cache4.get("y") === undefined ? "Pass: y已被删除" : "Fail: y仍存在");
  console.log(cache4.getSize() === 2 ? "Pass: 数量为2" : "Fail: 数量异常");
  cache4.clear();
  console.log(cache4.getSize() === 0 ? "Pass: clear清空成功" : "Fail: clear异常");

  console.log("\nTest 5: 边界用例 - 复杂类型作 Key (Symbol)");
  const sym1 = Symbol("id1");
  const sym2 = Symbol("id2");
  const cache5 = new LRUCache<symbol, { data: string }>(2);
  cache5.put(sym1, { data: "hello" });
  cache5.put(sym2, { data: "world" });
  console.log(cache5.get(sym1)?.data === "hello" ? "Pass: Symbol作Key正常" : "Fail: Symbol作Key异常");
}

runTests();
```

## TASK2: Reasoning

**问题 1：每条生产线每小时的产能各是多少？**

设 C 线每小时的产能为 x 件。
- B 线效率是 C 线的 2 倍，所以 B 线每小时产能为 2x 件。
- A 线效率是 B 线的 1.5 倍，所以 A 线每小时产能为 1.5 × 2x = 3x 件。

三条线同时满载运行时，每小时的总产能为：x + 2x + 3x = 6x 件

已知每天总产能按 1000 件计（即三条线满载运行 1 小时的产能为 1000 件）：
6x = 1000
x = 1000/6 ≈ 166.67 件

得出每条线每小时的实际产能：
- **C 线**：约 166.67 件
- **B 线**：2 × 166.67 ≈ 333.33 件
- **A 线**：3 × 166.67 = 500 件

**问题 2：一天实际总产量是多少？**

- A 线：停机 2 小时，运行 6 小时
- B 线：停机 1 小时，运行 7 小时
- C 线：不停机，运行 8 小时

一天实际总产量 = (500 × 6) + (333.33 × 7) + (166.67 × 8)
= 3000 + 2333.31 + 1333.36
= 6666.67 件

**问题 3：如果取消 A 线的维护停机，日产量增加多少百分比？**

增加的产量 = 500 × 2 = 1000 件
日产量增加百分比 = (1000 / 6666.67) × 100% ≈ 15.00%

## TASK3: Translation

**英文版：**
In a microservices architecture, a Service Mesh implements traffic management, service discovery, and load balancing through sidecar proxies. As the most popular service mesh implementation, Istio's data plane consists of Envoy proxies, while its control plane is responsible for configuration distribution and certificate management. Blue-green deployment and canary release are common release strategies in a service mesh; when combined with Traffic Mirroring, they enable zero-risk version switching.

**日文版：**
マイクロサービスアーキテクチャにおいて、サービスメッシュ（Service Mesh）はサイドカープロキシを介してトラフィック管理、サービスディスカバリ、およびロードバランシングを実現します。最も人気のあるサービスメッシュの実装として、IstioのデータプレーンはEnvoyプロキシで構成され、コントロールプレーンは構成の配布と証明書の管理を担当します。ブルーグリーンデプロイメントとカナリアリリースはサービスメッシュにおける一般的なリリース戦略であり、トラフィックミラーリング（Traffic Mirroring）と組み合わせることで、リスクゼロのバージョン切り替えを実現できます。

**英文版回译中文：**
在微服务架构中，服务网格通过 Sidecar 代理实现流量管理、服务发现和负载均衡。作为最受欢迎的服务网格实现，Istio 的数据平面由 Envoy 代理组成，而其控制平面则负责配置分发和证书管理。蓝绿部署和金丝雀发布是服务网格中常见的发布策略，当与流量镜像结合使用时，能够实现零风险的版本切换。

## TASK4: Analysis

**1. 整体架构图（文字描述）**

```text
[客户端]
   │ (长连接 WebSocket / TCP)
   ▼
┌─────────────────────────────────────────────────────────┐
│                 接入层 (Gateway Layer)                    │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐                 │
│  │Gateway-1│  │Gateway-2│  │Gateway-N│ (无状态, 负载均衡) │
│  └────┬────┘  └────┬────┘  └────┬────┘                 │
└───────┼────────────┼────────────┼───────────────────────┘
        │            │            │
        ▼            ▼            ▼
┌─────────────────────────────────────────────────────────┐
│             消息中间件层 (MQ Layer)                        │
│  ┌───────────────────────────────────────────┐          │
│  │ Kafka / RocketMQ (多 Topic/Partition)     │          │
│  │ - P2P Topic (点对点单聊)                   │          │
│  │ - Group Topic (群聊)                       │          │
│  └───────────────────────────────────────────┘          │
└────────────────┬───────────────────────┬────────────────┘
                 │ (消费)                │ (消费)
                 ▼                       ▼
┌────────────────────────────┐ ┌────────────────────────────┐
│ 消息处理集群  │ │   在线状态服务      │
│ - 消息持久化到 DB          │ │ - 维护 UserID <-> GW 映射 │
│ - 写入离线收件箱       │ │ - 基于 Redis 实现心跳检测  │
│ - 触发推送逻辑            │ │ - 提供路由查询 RPC 接口    │
└────────────┬───────────────┘ └─────────────┬──────────────┘
             │ Push API                   │ Route API
             ▼                            ▼
        (回调 Gateway 寻址并发送给目标在线用户)
```

**2. 消息投递的可靠性保证策略**
- **离线消息**：消息处理服务在持久化消息时，会同步将消息写入接收者的"收件箱"（Redis Hash 存近期离线消息，MongoDB/MySQL 存历史离线消息）。用户上线时，Gateway 从状态服务获取在线状态，并主动拉取或由处理服务推送未读消息。
- **消息不丢失**：Gateway 收到消息后先写入 MQ，同步等待 MQ 的 ACK 确认后再返回客户端成功。消费端从 MQ 拉取消息，必须成功持久化至数据库后，才向 MQ 发送 ACK 提交消费位移。Gateway 向目标客户端推送必须带有本地 MSG_ID，若未收到客户端 ACK，触发重试推送给该用户的其他在线节点。
- **消息不重复**：为每条消息生成全局唯一的 MessageID（雪花算法）。接收端处理服务利用 Redis 实现幂等校验，处理前 SETNX MessageID，成功则处理，失败则丢弃。客户端本地维护已接收消息的 ID 缓存（如最近 50 条），收到推送时过滤重复 ID。

**3. 与现有系统的平滑迁移方案（零停机）**
采用双写双读 + 灰度切流策略：
- 阶段一（双写）：改造单体应用，消息发送时同时写入旧架构和新的 MQ；消息接收端同时订阅旧 Redis Pub/Sub 和新 MQ。
- 阶段二（灰度切流）：在接入网关按 UID 尾号或百分比灰度，将部分用户的 WebSocket 长连接指向新 Gateway。
- 阶段三（全量切流）：逐渐扩大灰度比例至 100%。
- 阶段四（下线旧系统）：观察一周无误后，停止双写，断开 Redis Pub/Sub 订阅。

**4. 性能指标估算**
- 峰值 QPS = (10,000,000 × 50) / (86400 × 0.1) ≈ 57,870 QPS。整体架构按 10 万 QPS 设计。
- 同机房同在线用户 P99 延迟 < 50ms；跨机房/离线推送 P99 延迟 500ms-1s。
- Kafka 保留 3 天，每日新增约 500GB；热库（MongoDB）存近 3 个月，约 45TB。

**5. 方案的潜在风险和应对措施**
- MQ 堆积导致延迟飙升 → 死信队列 + 限流报警 + 非核心链路降级
- 在线状态服务不可用 → Redis Cluster + 本地化缓存 + 广播降级
- 海量群聊导致扇出风暴 → 大群单独 Topic + 读扩散取代写扩散
- 平滑迁移期间数据一致性 → 旧系统为准处理冲突 + MQ 消费端幂等
