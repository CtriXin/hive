# RateLimiter Code Review — 3 视角分析

---

## Challenger 视角（正确性）

### Finding 1: `Array.shift()` 在大窗口下性能退化 — 🟡 YELLOW

`isAllowed` 中 `while + shift()` 在极端情况下（如 burst 到 10 万请求后静默很久再请求）会遍历大量过期记录。`Array.shift()` 是 O(n)，总体 O(n²)。

**修复建议：** 使用双向指针或 `slice` 替代 `shift`：

```typescript
const cutoff = now - this.config.windowMs;
let start = 0;
while (start < timestamps.length && timestamps[start] < cutoff) {
  start++;
}
if (start > 0) {
  timestamps.splice(0, start);
}
```

### Finding 2: `getRetryAfterMs` 在恰好满窗口时可能返回负数 — 🟡 YELLOW

`getRetryAfterMs` 没有先清理过期记录。如果最早的 timestamp 恰好刚过期（但数组长度仍 ≥ maxRequests），计算结果为负数，语义错误。

```typescript
getRetryAfterMs(key: string): number {
  const timestamps = this.windows.get(key);
  if (!timestamps || timestamps.length < this.config.maxRequests) return 0;
  // 此处 timestamps[0] 可能已过期，导致返回负数
  return timestamps[0] + this.config.windowMs - Date.now();
}
```

**修复建议：** 先清理过期记录再计算，或 clamp 为 0：

```typescript
return Math.max(0, timestamps[0] + this.config.windowMs - Date.now());
```

### Finding 3: `getRemainingRequests` 不清理，返回值可能不一致 — 🟡 YELLOW

`getRemainingRequests` 用 `filter` 统计有效记录但**不回写**到 `windows`，而 `isAllowed` 的清理逻辑是 in-place 的。两次调用之间如果出现 gap，`getRema...
