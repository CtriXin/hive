# kimi-k2.5 完整答卷 — Round 1

## 响应元数据
- 模型: kimi-k2.5
- Task ID: eval-kimi-k25
- 响应时间: 94335ms
- Token: input=0, output=3961
- 状态: success

---

## TASK1: Coding

```typescript
class LRUCache<K, V> {
  private capacity: number;
  private cache: Map<K, V>;

  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new Error('Capacity must be positive');
    }
    this.capacity = capacity;
    this.cache = new Map();
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

  size(): number {
    return this.cache.size;
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }
}

function runTests() {
  console.log('=== LRU Cache Tests ===\n');

  const cache1 = new LRUCache<string, number>(3);
  cache1.put('a', 1);
  cache1.put('b', 2);
  cache1.put('c', 3);
  cache.log('After put a,b,c:', [...cache1['cache'].keys()]);
  cache1.get('a');
  cache1.put('d', 4);
  console.log('Has b?', cache1.has('b')); // false
  console.log('✓ Test 1 passed\n');

  const cache2 = new LRUCache<number, string>(1);
  cache2.put(1, 'one');
  cache2.put(2, 'two');
  console.log('Has 1?', cache2.has(1)); // false
  console.log('Get 2:', cache2.get(2)); // 'two'
  console.log('✓ Test 2 passed\n');

  const cache3 = new LRUCache<string, number>(2);
  cache3.put('x', 10);
  cache3.put('y', 20);
  cache3.put('x', 100);
  console.log('Size:', cache3.size()); // 2
  console.log('Get y:', cache3.get('y')); // 20
  console.log('✓ Test 3 passed\n');

  const cache4 = new LRUCache<string, number>(5);
  cache4.put('a', 1);
  cache4.put('b', 2);
  console.log('Delete a:', cache4.delete('a')); // true
  console.log('Delete a again:', cache4.delete('a')); // false
  cache4.clear();
  console.log('Size after clear:', cache4.size()); // 0
  console.log('✓ Test 4 passed\n');

  interface Key { id: number; name: string }
  const cache5 = new LRUCache<Key, string>(2);
  const key1: Key = { id: 1, name: 'a' };
  const key2: Key = { id: 2, name: 'b' };
  cache5.put(key1, 'value1');
  cache5.put(key2, 'value2');
  console.log('Get by same reference:', cache5.get(key1)); // 'value1'
  console.log('Get by different object:', cache5.get({ id: 1, name: 'a' })); // undefined
  console.log('✓ Test 5 passed\n');

  console.log('=== All tests passed! ===');
}

runTests();
```

## TASK2: Reasoning

设 C 线每小时产能为 c 件/小时
- B = 2c
- A = 1.5 × 2c = 3c

运行时间：A=6h, B=7h, C=8h
方程：6 × 3c + 7 × 2c + 8 × c = 1000 → 40c = 1000 → c = 25

问题 1：
- A: 75 件/小时
- B: 50 件/小时
- C: 25 件/小时

问题 2：450 + 350 + 200 = 1000 件 ✓

问题 3：新增 150 件，百分比 = 150/1000 × 100% = 15%

## TASK3: Translation

**英文版：**
"In a microservices architecture, the Service Mesh implements traffic management, service discovery, and load balancing through sidecar proxies. Istio, as the most popular Service Mesh implementation, consists of Envoy proxies in its data plane, while the control plane is responsible for configuration distribution and certificate management. Blue-green deployment and canary release are common release strategies in Service Mesh, and combined with Traffic Mirroring, zero-risk version switching can be achieved."

**日文版：**
「マイクロサービスアーキテクチャにおいて、サービスメッシュ（Service Mesh）はサイドカープロキシを通じてトラフィック管理、サービスディスカバリ、およびロードバランシングを実現します。最も普及しているサービスメッシュ実装であるIstioは、データプレーンにEnvoyプロキシを構成し、コントロールプレーンは設定配布と証明書管理を担当します。ブルーグリーンデプロイメントとカナリアリリースはサービスメッシュで一般的なリリース戦略であり、トラフィックミラーリング（Traffic Mirroring）と組み合わせることで、ゼロリスクのバージョン切り替えが実現できます。」

**英文版回译中文：**
"在微服务架构中，服务网格（Service Mesh）通过边车代理实现流量管理、服务发现和负载均衡。作为最流行的服务网格实现，Istio 的数据平面由 Envoy 代理组成，而控制平面负责配置分发和证书管理。蓝绿部署和金丝雀发布是服务网格中常见的发布策略，结合流量镜像（Traffic Mirroring）可以实现零风险的版本切换。"

## TASK4: Analysis

### 1. 整体架构图

```text
┌─────────────────────────────────────────────────────────────┐
│                         客户端层                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      接入网关层 (Access Gateway)               │
│    ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│    │ 负载均衡器    │  │  长连接网关   │  │   短连接 API 网关    │ │
│    │  (LVS/SLB)  │  │  (WebSocket) │  │     (HTTP/gRPC)     │ │
│    └─────────────┘  └─────────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      消息路由层 (Message Router)               │
│    ┌─────────────────────────────────────────────────────┐   │
│    │              Apache Kafka / Pulsar (消息总线)          │   │
│    │     分区策略：user_id % partition_num (保证有序性)      │   │
│    └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   消息服务集群     │  │   在线状态服务    │  │   离线存储服务    │
│  (Consumer Group)│  │  (Redis Cluster) │  │  (TiDB/ScyllaDB)│
└─────────────────┘  └─────────────────┘  └─────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      存储层 (Storage Layer)                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐   │
│  │ Redis Cluster│  │  TiDB/MySQL │  │    MinIO/OSS        │   │
│  │  (热数据缓存) │  │ (关系型数据) │  │   (文件/图片存储)    │   │
│  └─────────────┘  └─────────────┘  └─────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 2. 可靠性策略

**2.1 离线消息：** Redis 维护 user_id → [device_id: conn_id] 映射。心跳超时30s或主动断开，清除在线状态。消息写入 user_id 维度的离线队列（Kafka Compacted Topic 或 TiDB）。用户上线后主动拉取 last_ack_msg_id 之后的消息。

**2.2 消息不丢失（At-Least-Once）：**
- 客户端超时重试（指数退避，最多3次）
- 服务端按 client_msg_id 去重（写入前查 Bloom Filter）
- Kafka acks=all, min.insync.replicas=2

**2.3 消息不重复（Exactly-Once 语义）：**
- 生产端：client_msg_id（客户端生成 UUID）幂等去重
- 消费端：消息处理 + offset 提交 = 原子操作（Kafka Transactions 或外部幂等表）

### 3. 平滑迁移方案（零停机）

- 阶段一：双写准备（2周）— 新消息同时写入 Redis Pub/Sub 和 Kafka
- 阶段二：读切流（1周）— 灰度比例 50% → 100%
- 阶段三：老系统下线（1周）— 停止 Redis Pub/Sub 写入，保留只读7天

### 4. 性能指标估算

| 指标 | 估算依据 | 目标值 |
|------|---------|--------|
| 峰值在线 | DAU × 20% | 200 万 |
| 消息发送 QPS | 人均50条/天，峰值3倍 | 30万 QPS |
| 端到端延迟 P99 | 含网络往返 | < 100ms |
| 存储容量 | 消息200B/条，保留90天 | ~15 TB（热）+ 冷存储 |
| Kafka 分区 | 单分区10MB/s，峰值300MB/s | 64分区，可扩展至256 |

### 5. 潜在风险与应对

| 风险 | 影响 | 应对措施 |
|------|------|---------|
| Kafka 分区热点 | 单用户消息过多 | 虚拟分区：user_id 哈希到1024虚拟分区 |
| 长连接雪崩 | 百万连接同时重连 | 随机退避重连（1-30s），网关预热 |
| 离线消息堆积 | 大V离线后消息爆炸 | 单用户离线队列上限10万条，超限转冷存储 |
| 时钟不同步 | 消息乱序 | NTP 同步 + Lamport Timestamp 校正 |
| 跨地域延迟 | 多数据中心同步慢 | 就近接入 + CRDT 冲突解决 |
