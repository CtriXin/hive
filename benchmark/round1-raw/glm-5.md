# glm-5 完整答卷 — Round 1

## 响应元数据
- 模型: glm-5
- Task ID: eval-glm5
- 响应时间: 85387ms
- Token: input=673, output=3701
- 状态: success

---

## TASK1: Coding

```typescript
class ListNode<K, V> {
  key: K;
  value: V;
  prev: ListNode<K, V> | null = null;
  next: ListNode<K, V> | null = null;

  constructor(key: K, value: V) {
    this.key = key;
    this.value = value;
  }
}

class LRUCache<K, V> {
  private capacity: number;
  private cache: Map<K, ListNode<K, V>>;
  private head: ListNode<K, V>;
  private tail: ListNode<K, V>;

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error("Capacity must be greater than 0");
    this.capacity = capacity;
    this.cache = new Map();
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
      this.addNode(newNode);
      if (this.cache.size > this.capacity) {
        this.evictTail();
      }
    }
  }

  delete(key: K): boolean {
    const node = this.cache.get(key);
    if (!node) return false;
    this.removeNode(node);
    this.cache.delete(key);
    return true;
  }

  clear(): void {
    this.cache.clear();
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  private addNode(node: ListNode<K, V>): void {
    node.prev = this.head;
    node.next = this.head.next;
    if (this.head.next) {
      this.head.next.prev = node;
    }
    this.head.next = node;
  }

  private removeNode(node: ListNode<K, V>): void {
    const prevNode = node.prev;
    const nextNode = node.next;
    if (prevNode) prevNode.next = nextNode;
    if (nextNode) nextNode.prev = prevNode;
  }

  private moveToHead(node: ListNode<K, V>): void {
    this.removeNode(node);
    this.addNode(node);
  }

  private evictTail(): void {
    const nodeToRemove = this.tail.prev;
    if (nodeToRemove && nodeToRemove !== this.head) {
      this.removeNode(nodeToRemove);
      this.cache.delete(nodeToRemove.key);
    }
  }
}

function runTests() {
  console.log("Running LRU Cache Tests...\n");

  console.log("--- Test 1: Basic Eviction ---");
  const lru = new LRUCache<string, number>(3);
  lru.put("a", 1);
  lru.put("b", 2);
  lru.put("c", 3);
  console.log(`Get a: ${lru.get("a")} (Expected: 1)`);
  lru.put("d", 4);
  console.log(`Get b: ${lru.get("b")} (Expected: undefined)`);
  console.log(`Get a: ${lru.get("a")} (Expected: 1)`);
  console.log(`Get c: ${lru.get("c")} (Expected: 3)`);
  console.log(`Get d: ${lru.get("d")} (Expected: 4)`);

  console.log("\n--- Test 2: Update Key ---");
  lru.put("c", 33);
  console.log(`Get c: ${lru.get("c")} (Expected: 33)`);

  console.log("\n--- Test 3: Delete & Edge Cases ---");
  const lru2 = new LRUCache<number, string>(2);
  lru2.put(1, "one");
  lru2.delete(1);
  console.log(`Get deleted key: ${lru2.get(1)} (Expected: undefined)`);
  const lru3 = new LRUCache<number, number>(1);
  lru3.put(1, 100);
  lru3.put(2, 200);
  console.log(`Capacity 1 test: ${lru3.get(1)} (Expected: undefined), ${lru3.get(2)} (Expected: 200)`);
}

runTests();
```

## TASK2: Reasoning

**1. 变量定义与关系设定**
设 A、B、C 三条生产线在满载运行时的小时产能分别为 P_A, P_B, P_C。
1. P_A = 1.5 P_B
2. P_B = 2 P_C → P_A = 3 P_C
3. 标准工作日时长为 8 小时。
   - A 运行时间：6 小时
   - B 运行时间：7 小时
   - C 运行时间：8 小时

建立方程：
(P_A × 6) + (P_B × 7) + (P_C × 8) = 1000
(3 P_C × 6) + (2 P_C × 7) + (P_C × 8) = 1000
18 P_C + 14 P_C + 8 P_C = 1000
40 P_C = 1000
P_C = 25

**2. 计算结果**

问题 1：
- C 线: 25 件/小时
- B 线: 50 件/小时
- A 线: 75 件/小时

问题 2：1000 件（验证：75×6 + 50×7 + 25×8 = 450+350+200 = 1000）

问题 3：增加 150 件，百分比 = 150/1000 × 100% = 15%

## TASK3: Translation

**English Version:**
"In a microservices architecture, a Service Mesh facilitates traffic management, service discovery, and load balancing via sidecar proxies. As the most popular Service Mesh implementation, Istio comprises a data plane made of Envoy proxies and a control plane responsible for configuration distribution and certificate management. Blue-green deployment and Canary release are common release strategies within a Service Mesh, which, combined with Traffic Mirroring, can achieve zero-risk version switching."

**Japanese Version:**
「マイクロサービスアーキテクチャにおいて、サービスメッシュ（Service Mesh）はサイドカープロキシ（sidecar proxy）を介してトラフィック管理、サービスディスカバリ、および負荷分散を実現します。最も普及しているサービスメッシュの実装であるIstioは、Envoyプロキシで構成されるデータプレーンと、設定の配信および証明書管理を担うコントロールプレーンで構成されています。ブルーグリーンデプロイメントおよびカナリアリリースはサービスメッシュにおける一般的なリリース戦略であり、トラフィックミラーリング（Traffic Mirroring）と組み合わせることで、ゼロリスクでのバージョン切り替えを実現できます。」

**Chinese Back-Translation (from English):**
"在微服务架构中，服务网格通过 sidecar 代理促进流量管理、服务发现和负载均衡。作为最流行的服务网格实现，Istio 由 Envoy 代理构成的数据平面和负责配置分发及证书管理的控制平面组成。蓝绿部署和金丝雀发布是服务网格中常见的发布策略，配合流量镜像，可以实现零风险的版本切换。"

## TASK4: Analysis

放弃 Redis Pub/Sub 作为核心消息路由，转为"消息队列 + 持久化存储 + 长连接网关"的分布式架构。

**架构图示 (ASCII):**
```text
[ 客户端 ] <---- WS/TCP ----> [ 连接层 ]
                                     | (连接状态管理/Zookeeper)
                                     v
[ 业务层 ] <--- gRPC ---> [ 逻辑层 ]
                              |
         +--------------------+--------------------+
         |                    |                    |
         v                    v                    v
[ 消息队列 ] --> [ 消费者/Worker ] --> [ 存储层 ]
                                              |
                                              v
                                        [ 数据库分片 ]
                                              |
                                              v
                                        [ 离线存储 ]
```

- 接入层: 无状态长连接，负责协议解析、握手认证
- 逻辑层: 处理单聊、群聊、消息流转
- 消息队列: Kafka 提供高吞吐和持久化
- 存储层: Cassandra/HBase（写性能高），Redis 仅缓存在线状态

**可靠性：**
- 生产端: 客户端发消息后，服务端先写入 Kafka，再返回 ACK
- 消费端: At-Least-Once 模式，手动提交 offset
- 离线消息: 写扩散模式，发消息时直接写入接收者离线存储库
- 去重: 全局唯一 Snowflake ID + 客户端 LRU 缓存

**迁移方案：**
1. 双写阶段: 同时写入 Redis 和 Kafka
2. 数据同步: 迁移历史数据
3. 灰度切流: 5% → 100%
4. 下线旧系统

**性能：**
- 峰值 QPS ≈ 23,000
- 并发连接 ≈ 200 万
- 内网延迟 < 50ms

**风险：**
- 连接抖动: 智能心跳 + Session Resumption
- 群聊风暴: 限流 + 读写分离
- 状态不一致: ZooKeeper 集中式 Session 管理
