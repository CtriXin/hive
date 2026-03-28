# MiniMax-M2.7 完整答卷 — Round 1

## 响应元数据
- 模型: MiniMax-M2.7
- Task ID: eval-minimax-m27
- 响应时间: 159057ms
- Token: input=660, output=6940
- 状态: success

---

## TASK1: Coding

```typescript
class LRUCache<K, V> {
  private readonly capacity: number;
  private cache: Map<K, V>;

  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new Error('Capacity must be a positive integer');
    }
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
    }
    this.cache.set(key, value);
    if (this.cache.size > this.capacity) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  get size(): number {
    return this.cache.size;
  }

  get maxCapacity(): number {
    return this.capacity;
  }
}

// Boundary Test Cases (using vitest)
import { describe, it, expect, beforeEach } from 'vitest';

describe('LRU Cache - Boundary Test Cases', () => {
  // Capacity = 1
  describe('Capacity = 1 (Edge Case)', () => {
    let cache: LRUCache<string, number>;
    beforeEach(() => { cache = new LRUCache<string, number>(1); });

    it('should only keep the most recently accessed item', () => {
      cache.put('a', 1);
      cache.put('b', 2);
      cache.put('c', 3);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('c')).toBe(3);
      expect(cache.size).toBe(1);
    });
  });

  // Update existing key
  describe('Update Existing Key (No Eviction)', () => {
    let cache: LRUCache<string, string>;
    beforeEach(() => { cache = new LRUCache<string, string>(3); });

    it('should update value without evicting', () => {
      cache.put('a', 'value-a');
      cache.put('b', 'value-b');
      cache.put('c', 'value-c');
      cache.put('a', 'updated-a');
      cache.put('d', 'value-d');
      expect(cache.get('a')).toBe('updated-a');
      expect(cache.get('b')).toBeUndefined();
      expect(cache.size).toBe(3);
    });
  });

  // Mixed operations
  describe('Mixed Operations', () => {
    let cache: LRUCache<number, number>;
    beforeEach(() => { cache = new LRUCache<number, number>(4); });

    it('should handle complex interleaved operations correctly', () => {
      cache.put(1, 100); cache.put(2, 200); cache.put(3, 300); cache.put(4, 400);
      expect(cache.get(1)).toBe(100);
      cache.put(5, 500);
      expect(cache.get(2)).toBeUndefined();
      cache.delete(3);
      cache.put(6, 600);
      expect(cache.get(3)).toBeUndefined();
      expect(cache.has(1)).toBe(true);
      expect(cache.has(5)).toBe(true);
      expect(cache.has(6)).toBe(true);
      expect(cache.size).toBe(3);
      cache.clear();
      expect(cache.size).toBe(0);
    });
  });

  // Type safety
  describe('Type Safety', () => {
    it('should work with various key/value types', () => {
      const cache1 = new LRUCache<string, number>(10);
      cache1.put('count', 42);
      expect(cache1.get('count')).toBe(42);

      const cache2 = new LRUCache<number, { name: string }>(10);
      cache2.put(1, { name: 'Alice' });
      expect(cache2.get(1)).toEqual({ name: 'Alice' });
    });
  });

  // Error handling
  describe('Error Handling', () => {
    it('should throw error for invalid capacity', () => {
      expect(() => new LRUCache<string, number>(0)).toThrow('Capacity must be a positive integer');
      expect(() => new LRUCache<string, number>(-1)).toThrow('Capacity must be a positive integer');
    });
  });
});

export { LRUCache };
```

Note: clear() 注释写 O(n) 实际应 O(n)，测试中 `cache3.set()` 应为 `cache3.put()`。

## TASK2: Reasoning

设 C 线每小时产能为 x 件/小时
- B = 2x
- A = 3x

运行时间：A=6h, B=7h, C=8h
方程：18x + 14x + 8x = 1000 → 40x = 1000 → x = 25

- C: 25 件/小时
- B: 50 件/小时
- A: 75 件/小时

日产量 = 450 + 350 + 200 = 1000 件 ✓

取消 A 停机后新增 150 件，百分比 = 15%

## TASK3: Translation

**English:**
"In microservices architecture, Service Mesh implements traffic management, service discovery, and load balancing through sidecar proxies. Istio, as the most popular Service Mesh implementation, consists of a data plane composed of Envoy proxies, while the control plane is responsible for configuration distribution and certificate management. Blue-green deployment and canary release are common deployment strategies in Service Mesh, which, combined with Traffic Mirroring, can achieve zero-risk version switching."

**Japanese:**
"マイクロサービスアーキテクチャにおいて、Service Meshはサイドカープロキシを通じてトラフィック管理、服务発見、負荷分散を実現します。Istioは最も普及しているService Mesh実装であり、そのデータプレーンはEnvoyプロキシで構成され、コントロールプレーンは設定の配布と証明書管理を担当します。ブルーグリーンデプロイとカナリーリリースはService Meshにおける一般的なデプロイ戦略であり、トラフィックミラーリングと組み合わせることで、ゼロリスクなバージョン切り替えを実現できます。"

Note: 日文中有"服务発見"（应为"サービスディスカバリ"）和"カナリーリリース"（少一个ア）。

**Back to Chinese:**
"在微服务架构中，服务网格通过 sidecar 代理实现流量管理、服务发现和负载均衡。Istio 作为最流行的服务网格实现，其数据平面由 Envoy 代理组成，控制平面负责配置分发和证书管理。蓝绿部署和金丝雀发布是服务网格中常见的部署策略，结合流量镜像可实现零风险的版本切换。"

## TASK4: Analysis

(Full architecture diagram with Client Layer → Edge Layer → API Gateway → Message Push/Store/Presence Services → Message Routing Layer (Kafka + Redis) → Storage Layer (Cassandra + MySQL))

**2. Reliability:**
- Offline: Check online status → store in Cassandra → on login batch push
- No loss: Producer ACK, Kafka replication factor 3, consumer manual commit, Transaction Outbox
- No duplicate: UUID message_id, Redis SETNX dedup, UNIQUE constraint on message_id

**3. Migration (4 phases):**
- Phase 1: Dual-Write (Week 1-2) with verification dashboard
- Phase 2: Canary 5%→10%→30%→50%→100%
- Phase 3: Full write migration, old system read-only
- Phase 4: Decommission after 2 weeks observation

**4. Performance:**
- Peak: 10K TPS
- P99 latency targets: Send <200ms, Receive <500ms
- Storage: 600GB/day, 35TB hot (30-day retention)

**5. Risks (8 items with probability/impact/mitigation):**
- Kafka lag, Redis split-brain, WebSocket storm, message ordering, data inconsistency, Cassandra compaction, hotspot user, security/DDoS
- Includes full observability stack (Prometheus+Grafana, ELK, Jaeger, PagerDuty)
