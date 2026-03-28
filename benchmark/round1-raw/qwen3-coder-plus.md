# qwen3-coder-plus 完整答卷 — Round 1

## 响应元数据
- 模型: qwen3-coder-plus
- Task ID: eval-qwen3coder
- 响应时间: 33640ms
- Token: input=708, output=2052
- 状态: success

---

## TASK1: Coding

```typescript
class LRUCache<K, V> {
    private capacity: number;
    private cache: Map<K, V>;

    constructor(capacity: number) {
        if (capacity <= 0) throw new Error('Capacity must be positive');
        this.capacity = capacity;
        this.cache = new Map<K, V>();
    }

    get(key: K): V | undefined {
        if (!this.cache.has(key)) return undefined;
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

    delete(key: K): boolean { return this.cache.delete(key); }
    clear(): void { this.cache.clear(); }
    size(): number { return this.cache.size; }
    has(key: K): boolean { return this.cache.has(key); }
    keys(): K[] { return Array.from(this.cache.keys()); }
}
```

Simple Map-based implementation. Correct but not the classic doubly-linked-list approach.
3 basic test cases.

评分：7 (correct but minimal)

## TASK2: Reasoning

Standard interpretation: x=25, A=75, B=50, C=25, total=1000, +15%.
评分：10

## TASK3: Translation

English accurate. Japanese has "サイドカー代理" (should be "サイドカープロキシ"). Back-translation faithful.
评分：8.5

## TASK4: Analysis

Very brief (shortest of all models, ~2KB output):
- Simple ASCII architecture
- 3-line reliability strategies (no detail)
- 4-line migration plan
- QPS: 500K+ (claimed without calculation basis)
- 4-line risk mitigation

评分：6 (severely lacking depth for a senior-level architecture question)
