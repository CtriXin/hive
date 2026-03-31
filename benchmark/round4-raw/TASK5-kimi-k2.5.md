[Read: /Users/xin/.sce/beliefs/SUMMARY.md]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/.ai/manifest.json]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/.ai/plan/current.md]

这是一个独立的部署规划问题，与当前项目的 flash sale 功能无关。我将直接解决这个微服务部署优化问题。

## 微服务部署方案

### 约束分析

**硬约束：**
1. API Gateway → 必须 Zone-A + 需要 SSD → 只能 Server1 或 Server2
2. Cache Service → 必须和 API Gateway 同 Zone + 需要 SSD → Zone-A 且 SSD
3. Order Service 和 Payment Service → 不能同服务器
4. Order Service → 需要 SSD
5. Payment Service → 需要 SSD
6. 需要 SSD 的服务不能部署在 Server3 (HDD)

**软约束：**
- Analytics Service (8核) → 优先高核数服务器 (Server1 或 Server3)
- 同一 Zone 内服务通信延迟更低

---

### 部署方案

| 服务器 | 部署服务 | CPU | 内存 | 磁盘 |
|--------|----------|-----|------|------|
| **Server1** (16核/64GB/SSD/Zone-A) | API Gateway + Cache Service + Notification Service | 7核 | 26GB | SSD |
| **Server2** (8核/32GB/SSD/Zone-A) | Order Service + User Service | 6核 | 20GB | SSD |
| **Server3** (16核/64GB/HDD/Zone-B) | Analytics Service + Search Service | 12核 | 48GB | HDD |
| **Server4** (8核/16GB/SSD/Zone-B) | Payment Service | 4核 | 8GB | SSD |

---

### 详细资源使用情况

```
Server1 (Zone-A, SSD): 16核/64GB
├── API Gateway    : 4核 / 8GB  / SSD ✓
├── Cache Service  : 2核 / 16GB / SSD ✓
├── Notification   : 1核 / 2GB  / -   ✓
├── 总计           : 7核 / 26GB / (余 9核, 38GB)

Server2 (Zone-A, SSD): 8核/32GB
├── Order Service  : 4核 / 16GB / SSD ✓
├── User Service   : 2核 / 4GB  / -   ✓
├── 总计           : 6核 / 20GB / (余 2核, 12GB)

Server3 (Zone-B, HDD): 16核/64GB
├── Analytics      : 8核 / 16GB / -   ✓ (高核数优先满足)
├── Search Service : 4核 / 32GB / -   ✓ (大内存需求)
├── 总计           : 12核 / 48GB / (余 4核, 16GB)

Server4 (Zone-B, SSD): 8核/16GB
├── Payment Service: 4核 / 8GB  / SSD ✓
├── 总计           : 4核 / 8GB  / (余 4核, 8GB)
```

---

### 约束满足情况检查

| 约束 | 状态 | 说明 |
|------|------|------|
| 1. CPU/内存不超限 | ✅ | 所有服务器资源使用 ≤ 上限 |
| 2. SSD 服务部署正确 | ✅ | Order/Payment/Cache/API Gateway 都在 SSD 服务器 |
| 3. Zone 约束满足 | ✅ | API Gateway 在 Zone-A |
| 4. Order ≠ Payment 同机 | ✅ | Order 在 Server2, Payment 在 Server4 |
| 5. Cache 与 API Gateway 同 Zone | ✅ | 都在 Zone-A (Server1) |
| 6. Analytics 优先高核数 | ✅ | 部署在 16核 Server3 (软约束满足) |
| 7. 负载相对平衡 | ⚠️ | Server4 较空闲，但受约束限制 |
| 8. 相关服务同 Zone | ✅ | Zone-A: API Gateway + Order + Cache + User + Notification |

---

### Server4 宕机降级方案

**Server4 承载：** Payment Service (4核/8GB/需SSD)

**可选迁移目标：** Server1 或 Server2 (都有 SSD)

**降级方案：**
- 将 Payment Service 迁移至 **Server2**
- Server2 新负载: Order(4核) + User(2核) + Payment(4核) = **10核 > 8核** ❌ 超限

**可行方案：**
- 将 Payment Service 迁移至 **Server1**
- Server1 新负载: 7核 + 4核 = **11核 > 16核** ✅
- Server1 新内存: 26GB + 8GB = **34GB < 64GB** ✅

**调整后：**

| 服务器 | 新部署 |
|--------|--------|
| Server1 | API Gateway + Cache + Notification + **Payment** |
| Server2 | Order + User |
| Server3 | Analytics + Search |

> ⚠️ 注意：此时 Order 和 Payment 分离约束仍满足 (Server2 vs Server1)

---

### 方案优劣分析

**优势：**
1. ✅ 所有硬约束完全满足
2. ✅ Analytics 部署在 16核服务器，CPU 密集型需求得到优化
3. ✅ Zone-A 集中了主要流量入口 (API Gateway + Order)，延迟优化
4. ✅ Cache 与 API Gateway 同 Zone，减少跨 Zone 调用

**劣势：**
1. ⚠️ Server4 利用率较低 (仅 50% CPU, 50% 内存)
2. ⚠️ Server2 余量较少 (2核/12GB)，突发负载能力弱
3. ⚠️ Server4 宕机后，Server1 负载上升 (11核/34GB)，但仍在安全范围

**优化建议：**
- 若允许 Cache Service 和 API Gateway 分离 Zone，可将 Cache 移至 Server4，平衡负载
- 或考虑将 User Service 移至 Server4，释放 Server2 余量