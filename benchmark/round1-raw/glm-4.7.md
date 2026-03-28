# glm-4.7 完整答卷 — Round 1

## 响应元数据
- 模型: glm-4.7
- Task ID: eval-glm47
- 响应时间: 126957ms
- Token: input=671, output=4361
- 状态: success

---

## TASK1: Coding

```typescript
class ListNode<K, V> {
  constructor(
    public key: K,
    public value: V,
    public prev: ListNode<K, V> | null = null,
    public next: ListNode<K, V> | null = null
  ) {}
}

class LRUCache<K, V> {
  private capacity: number;
  private cache: Map<K, ListNode<K, V>>;
  private head: ListNode<K, V>;
  private tail: ListNode<K, V>;
  private size: number;

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error("Capacity must be greater than 0");
    this.capacity = capacity;
    this.cache = new Map();
    this.size = 0;
    this.head = new ListNode<K, V>(null as any, null as any);
    this.tail = new ListNode<K, V>(null as any, null as any);
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  get(key: K): V | undefined {
    const node = this.cache.get(key);
    if (!node) return undefined;
    this.moveToHead(node);
    return node.value;
  }

  put(key: K, value: V): void {
    const node = this.cache.get(key);
    if (node) {
      node.value = value;
      this.moveToHead(node);
    } else {
      const newNode = new ListNode(key, value);
      this.cache.set(key, newNode);
      this.addToHead(newNode);
      this.size++;
      if (this.size > this.capacity) {
        this.removeTail();
      }
    }
  }

  delete(key: K): boolean {
    const node = this.cache.get(key);
    if (!node) return false;
    this.removeNode(node);
    this.cache.delete(key);
    this.size--;
    return true;
  }

  clear(): void {
    this.cache.clear();
    this.head.next = this.tail;
    this.tail.prev = this.head;
    this.size = 0;
  }

  private moveToHead(node: ListNode<K, V>): void {
    this.removeNode(node);
    this.addToHead(node);
  }

  private addToHead(node: ListNode<K, V>): void {
    node.prev = this.head;
    node.next = this.head.next;
    if (this.head.next) {
      this.head.next.prev = node;
    }
    this.head.next = node;
  }

  private removeNode(node: ListNode<K, V>): void {
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
  }

  private removeTail(): void {
    const lru = this.tail.prev;
    if (lru && lru !== this.head) {
      this.removeNode(lru);
      this.cache.delete(lru.key);
      this.size--;
    }
  }

  getLength(): number {
    return this.size;
  }
}

// 测试代码
function runTests() {
  console.log("开始测试...");

  const cache1 = new LRUCache<number, string>(2);
  cache1.put(1, "one");
  cache1.put(2, "two");
  console.assert(cache1.get(1) === "one", "Test 1a failed");
  cache1.put(3, "three");
  console.assert(cache1.get(2) === undefined, "Test 1b failed");
  cache1.put(4, "four");
  console.assert(cache1.get(1) === undefined, "Test 1c failed");
  console.assert(cache1.get(3) === "three", "Test 1d failed");
  console.assert(cache1.get(4) === "four", "Test 1e failed");
  console.log("✅ 用例 1 通过: 基本淘汰逻辑正确");

  interface User { id: number; name: string; }
  const cache2 = new LRUCache<string, User>(1);
  const userA: User = { id: 101, name: "Alice" };
  const userB: User = { id: 102, name: "Bob" };
  cache2.put("session_1", userA);
  console.assert(cache2.get("session_1")?.name === "Alice", "Test 2a failed");
  cache2.put("session_2", userB);
  console.assert(cache2.get("session_1") === undefined, "Test 2b failed");
  console.assert(cache2.get("session_2")?.id === 102, "Test 2c failed");
  console.log("✅ 用例 2 通过: 复杂类型支持正确");

  const cache3 = new LRUCache<string, number>(3);
  cache3.put("a", 1);
  cache3.put("b", 2);
  cache3.put("c", 3);
  const deleted = cache3.delete("b");
  console.assert(deleted === true, "Test 3a failed");
  console.assert(cache3.get("b") === undefined, "Test 3b failed");
  console.assert(cache3.getLength() === 2, "Test 3c failed");
  const deletedAgain = cache3.delete("z");
  console.assert(deletedAgain === false, "Test 3d failed");
  cache3.clear();
  console.assert(cache3.getLength() === 0, "Test 3e failed");
  console.assert(cache3.get("a") === undefined, "Test 3f failed");
  console.log("✅ 用例 3 通过: 删除和清空操作正确");
  console.log("🎉 所有测试通过!");
}

runTests();
```

## TASK2: Reasoning

设定变量与效率关系：
设 C 线每小时的产能为 x。
- B 线效率是 C 线的 2 倍 → B 线每小时的产能为 2x。
- A 线效率是 B 线的 1.5 倍 → A 线每小时的产能为 1.5 × 2x = 3x。

计算每日实际运行时间：
- A 线：运行 6 小时
- B 线：运行 7 小时
- C 线：运行 8 小时

利用总产能方程求解 x：
"每天总产能 1000 件"指的是三条线在各自的实际运行时间内产出的总和。

方程为：
3x × 6 + 2x × 7 + x × 8 = 1000
18x + 14x + 8x = 1000
40x = 1000
x = 25

回答问题：
1. C 线: 25 件/小时, B 线: 50 件/小时, A 线: 75 件/小时
2. 总产量为 1000 件（验证：75×6 + 50×7 + 25×8 = 450+350+200 = 1000）
3. 新总产量 = 1150 件，增加百分比 = 150/1000 × 100% = 15%

## TASK3: Translation

**English Translation:**
"In a microservices architecture, Service Mesh manages traffic, service discovery, and load balancing through sidecar proxies. As the most popular Service Mesh implementation, Istio's data plane consists of Envoy proxies, while the control plane is responsible for configuration distribution and certificate management. Blue-green deployment and canary release are common release strategies in Service Mesh; when combined with Traffic Mirroring, they enable zero-risk version switching."

**Japanese Translation:**
「マイクロサービスアーキテクチャにおいて、サービスメッシュはサイドカープロキシを通じてトラフィック管理、サービスディスカバリー、およびロードバランシングを実現します。最も広く使われているサービスメッシュの実装であるIstioの場合、データプレーンはEnvoyプロキシで構成され、コントロールプレーンは構成の配布と証明書管理を担当します。ブルーグリーンデプロイメントとカナリアリリースはサービスメッシュにおける一般的なリリース戦略であり、トラフィックミラーリングと組み合わせることで、リスクのないバージョン切り替えが可能になります。」

**Back to Chinese (from English):**
"在微服务架构中，服务网格通过 sidecar 代理来管理流量、服务发现和负载均衡。作为最流行的服务网格实现，Istio 的数据平面由 Envoy 代理组成，而控制平面则负责配置分发和证书管理。蓝绿部署和金丝雀发布是服务网格中常见的发布策略，结合流量镜像，能够实现零风险的版本切换。"

## TASK4: Analysis

### 1. 整体架构图 (ASCII)

```text
+-------------------------------------------------------+
|                   Client (Mobile/Web)                |
+---------------------------+---------------------------+
                            |
                            v
+-------------------------------------------------------+
|               API Gateway / Load Balancer             |
+---------------------------+---------------------------+
                            |
        +-------------------+-------------------+
        |                   |                   |
+-------v-------+   +-------v-------+   +-------v-------+
|  IM Service   |   |  IM Service   |   |  IM Service   |  <--- 无状态接入层
| (Connector)   |   | (Connector)   |   | (Connector)   |
+-------+-------+   +-------+-------+   +-------+-------+
        |                   |                   |
        +-------------------+-------------------+
                            |
                            v
+-------------------------------------------------------+
|               Kafka / Pulsar Cluster                  |
|  (Topic: P2P-Msg, Group-Msg, Notification-System)    |
+-------------------------------------------------------+
        |                                   |
        v                                   v
+-------+-------+                   +-------+-------+
|  Push Service |                   |  History DB  |
| (Logic Server)|                   | (Elastic/    |
| (Consumer)    |                   |  MongoDB/Cassandra)|
+-------+-------+                   +-------+-------+
        |                                   |
        v                                   v
+-------+-------+                   +-------+-------+
|  Dispatcher   |                   |  Storage S3/  |
| (Offline/Push)|                   |  HDFS Archive |
+---------------+                   +---------------+
```

### 2. 消息投递可靠性保证策略

- 离线消息: 用户上线连接后，接入层从 History DB 拉取该用户的"未读消息队列"。消息写入 Kafka 后，消费者服务将消息持久化写入 History DB，写入 DB 成功后才向 Kafka 发送 ACK。
- 消息不丢失: 接入层发送到 Kafka 时开启 acks=all。消费者采用"至少一次"投递，确认推送成功后才提交 Kafka Consumer Offset。History DB 采用副本集机制。
- 消息不重复: 每条消息生成全局唯一 UUID。客户端本地维护最近收到消息的 ID 缓存（LRU Set 或 Bloom Filter）。服务端在 History DB 存储时使用 MessageID + UserID 作为唯一索引。

### 3. 平滑迁移方案 (零停机)

- 阶段一: 部署新架构但不切流量。旧架构中增加拦截器，将所有消息异步转发到新 Kafka 集群。启动数据同步任务同步 Redis 数据。
- 阶段二: 引入配置开关，特定 UserID 的读请求指向新架构。验证数据一致性和读取性能。
- 阶段三: 使用网关路由，1% → 10% → 50% → 100% 写请求切到新架构。新架构处理完成后将消息同步回旧架构。
- 阶段四: 当流量 100% 切至新架构且稳定运行 24 小时后，停止旧架构双写逻辑，下线 Redis Pub/Sub。

### 4. 性能指标估算

- 日总消息量: 2 × 10^8 条
- 平均 QPS: ≈ 2315
- 峰值 QPS: ≈ 11,500
- 端到端目标: < 200ms (P99)
- Kafka 保留 7 天: 需 1.4TB 磁盘
- History DB 在线热数据（近3个月）: 约 18TB

### 5. 潜在风险和应对措施

- Kafka 消费堆积 → 动态扩容消费者 + 降级策略暂停非核心通知
- 数据一致性（双写期间）→ 消息体增加逻辑时间戳，客户端按时间戳排序，监控新旧链路延迟
- 长连接管理 → Go/Netty 高性能连接层 + Linux 内核参数优化
