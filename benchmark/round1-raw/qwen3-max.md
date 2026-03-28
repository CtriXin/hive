# qwen3-max 完整答卷 — Round 1

## 响应元数据
- 模型: qwen3-max
- Task ID: eval-qwen3max
- 响应时间: 93307ms
- Token: input=708, output=3080
- 状态: success

---

## TASK1: Coding

```typescript
class LRUCache<K, V> {
  private capacity: number;
  private cache: Map<K, V>;
  private keyOrder: K[];  // BUG: Array indexOf is O(n), breaks O(1) requirement

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error('Capacity must be greater than 0');
    this.capacity = capacity;
    this.cache = new Map<K, V>();
    this.keyOrder = [];
  }

  get(key: K): V | undefined {
    if (!this.cache.has(key)) return undefined;
    const index = this.keyOrder.indexOf(key);  // O(n) !
    if (index !== -Index) {  // TYPO BUG: -Index should be -1
      this.keyOrder.splice(index, 1);
      this.keyOrder.push(key);
    }
    return this.cache.get(key);
  }

  put(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.set(key, value);
      const index = this.keyOrder.indexOf(key);  // O(n) !
      if (index !== -1) {
        this.keyOrder.splice(index, 1);
        this.keyOrder.push(key);
      }
    } else {
      if (this.cache.size >= this.capacity) {
        const lruKey = this.keyOrder.shift();
        if (lruKey !== undefined) this.cache.delete(lruKey);
      }
      this.cache.set(key, value);
      this.keyOrder.push(key);
    }
  }

  delete(key: K): boolean {
    const exists = this.cache.has(key);
    if (exists) {
      this.cache.delete(key);
      const index = this.keyOrder.indexOf(key);
      if (index !== -1) this.keyOrder.splice(index, 1);
    }
    return exists;
  }

  clear(): void {
    this.cache.clear();
    this.keyOrder = [];
  }

  size(): number { return this.cache.size; }
  has(key: K): boolean { return this.cache.has(key); }
}
```

**CRITICAL BUGS:**
1. `keyOrder` is an Array — `indexOf()` and `splice()` are O(n), completely violating the O(1) requirement
2. `index !== -Index` — should be `-1`, this is a runtime error (undefined variable `-Index`)
3. Even without the typo bug, the algorithm is fundamentally wrong for O(1)

评分：4

## TASK2: Reasoning

Interpreted "total capacity 1000" as theoretical full-load (all 3 lines × 8h):
48x = 1000 → x = 125/6 ≈ 20.833
- A: 62.5 件/h, B: 41.67 件/h, C: 20.83 件/h
- Actual daily: 6×62.5 + 7×41.67 + 8×20.83 ≈ 833 件
- Percentage increase: 15% (correct regardless of interpretation)

评分：8 (non-standard interpretation but mathematically valid)

## TASK3: Translation

Good quality across all three languages. English and Japanese are accurate. Back-translation faithful.
评分：9

## TASK4: Analysis

Simple architecture: Clients → Gateway → Message Router (Kafka/Pulsar) → User Presence (Redis) + Message Storage (Cassandra/ScyllaDB) → Delivery Workers → Push Notification.

Reliability: Persistent storage with TTL, ACK-based delivery, UUID dedup.

Migration: 4 phases (deploy → dual-write → gradual migrate → decommission).

Performance: Only 2,778 QPS estimated (significantly low for 10M DAU), 20GB/day storage, 600GB for 30-day retention.

Risks: 5 brief items (MQ bottleneck, database hotspots, network partitions, migration complexity, operational complexity).

评分：6 (very brief, low QPS estimate suggests shallow analysis)
