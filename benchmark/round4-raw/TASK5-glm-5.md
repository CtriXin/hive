## 1. 完整部署方案

### 服务器资源总览

| 服务器 | CPU | 内存 | 磁盘 | Zone |
|--------|-----|------|------|------|
| Server1 | 16核 | 64GB | SSD | Zone-A |
| Server2 | 8核 | 32GB | SSD | Zone-A |
| Server3 | 16核 | 64GB | HDD | Zone-B |
| Server4 | 8核 | 16GB | SSD | Zone-B |

### 部署方案

```
┌─────────────────────────────────────────────────────────────┐
│                         Zone-A                               │
├─────────────────────────────┬───────────────────────────────┤
│        Server1 (SSD)        │        Server2 (SSD)          │
│   16核/64GB 可用            │    8核/32GB 可用              │
├─────────────────────────────┼───────────────────────────────┤
│ • API Gateway   (4核/8GB)   │ • Payment Service (4核/8GB)   │
│ • Cache Service (2核/16GB)  │ • Search Service  (4核/32GB)  │
│ • Analytics     (8核/16GB)  │                               │
├─────────────────────────────┼───────────────────────────────┤
│   使用: 14核/40GB           │   使用: 4核/8GB               │
│   剩余: 2核/24GB            │   剩余: 4核/24GB              │
└─────────────────────────────┴───────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                         Zone-B                               │
├─────────────────────────────┬───────────────────────────────┤
│        Server3 (HDD)        │        Server4 (SSD)          │
│   16核/64GB 可用            │    8核/16GB 可用              │
├─────────────────────────────┼───────────────────────────────┤
│ • User Service  (2核/4GB)   │ • Order Service   (4核/16GB)  │
│ • Notification (1核/2GB)    │                               │
├─────────────────────────────┼───────────────────────────────┤
│   使用: 3核/6GB             │   使用: 4核/16GB              │
│   剩余: 13核/58GB           │   剩余: 4核/0GB               │
└─────────────────────────────┴───────────────────────────────┘
```

## 2. 资源使用情况

| 服务器 | CPU使用 | CPU剩余 | 内存使用 | 内存剩余 | 磁盘类型 | 部署服务数 |
|--------|---------|---------|----------|----------|----------|------------|
| Server1 | 14/16 (87.5%) | 2核 | 40/64GB (62.5%) | 24GB | SSD | 3 |
| Server2 | 4/8 (50%) | 4核 | 8/32GB (25%) | 24GB | SSD | 1 |
| Server3 | 3/16 (18.8%) | 13核 | 6/64GB (9.4%) | 58GB | HDD | 2 |
| Server4 | 4/8 (50%) | 4核 | 16/16GB (100%) | 0GB | SSD | 1 |

## 3. 约束验证

### 硬约束检查

| # | 约束条件 | 验证结果 |
|---|----------|----------|
| 1 | CPU/内存不超限 | ✅ 全部满足 |
| 2 | SSD服务不在HDD服务器 | ✅ Order/Payment/API/Cache 都在 SSD |
| 3 | Zone约束 | ✅ API Gateway 在 Zone-A (Server1) |
| 4 | Order≠Payment同服务器 | ✅ Order在Server4，Payment在Server2 |
| 5 | Cache与API同Zone | ✅ 都在 Zone-A |

### 软约束检查

| # | 软约束 | 验证结果 |
|---|--------|----------|
| 6 | Analytics优先高核数 | ✅ 部署在16核Server1 |
| 7 | 负载均衡 | ⚠️ Server1较满(87.5%)，Server3空闲(18.8%) |
| 8 | 相关服务同Zone | ✅ API+Cache+Analytics在Zone-A（高流量链路） |

## 4. Server4 宕机降级方案

**影响**: Order Service (4核/16GB/SSD) 不可用

**迁移方案**: 将 Order Service 迁移到 Server2

```
┌─────────────────────────────────────────────────────────────┐
│                     降级后部署                               │
├─────────────────────────────┬───────────────────────────────┤
│        Server1 (SSD)        │        Server2 (SSD)          │
│   API + Cache + Analytics   │ Payment + Order (迁移)        │
│   14核/40GB                 │ 8核/24GB (满载)               │
├─────────────────────────────┼───────────────────────────────┤
│        Server3 (HDD)        │        Server4 (宕机)         │
│   User + Notification       │         ❌                    │
│   3核/6GB                   │                               │
└─────────────────────────────┴───────────────────────────────┘
```

**约束验证**:
- ✅ Order/Payment 仍在不同服务器 (Server2 vs Server2... ❌ 冲突!)
- 需要调整: **Payment 迁移到 Server1，Order 留在 Server2**

**正确降级方案**:

```
Server1: API Gateway + Cache + Notification (7核/26GB) + Payment (4核/8GB)
         = 11核/34GB，剩余5核/30GB ✅

Server2: Search + Order (迁移)
         = 8核/48GB... ❌ 内存超限 (32GB < 48GB)
```

**最终可行降级方案**:

| 服务 | 原位置 | 降级后位置 | 备注 |
|------|--------|------------|------|
| Order Service | Server4 | Server3 (HDD) | **牺牲SSD要求**，或扩容Server2 |
| Payment Service | Server2 | Server2 | 保持不变 |

由于 Server3 是 HDD，Order 需要 SSD，**需要二选一**:
1. **牺牲性能**: Order 部署到 Server3 (HDD)，性能下降
2. **垂直扩容**: 升级 Server2 内存到 48GB+
3. **水平扩容**: 新增 Server5 (SSD, 8核, 16GB+)

**推荐**: 方案1 (临时牺牲性能) + 触发 Server4 恢复告警

## 5. 方案优劣分析

### 优势 ✅

1. **硬约束100%满足**: 所有强制性约束全部达成
2. **高可用设计**: Order/Payment 物理隔离，避免单点故障
3. **性能优化**: Analytics 在高核服务器，Search 有完整32GB内存
4. **Zone亲和**: API+Cache+Payment 在 Zone-A，减少跨Zone延迟
5. **扩展性好**: Server2/Server3 有充足剩余资源应对扩容

### 劣势 ⚠️

1. **负载不均衡**: Server1 (87.5%) vs Server3 (18.8%)
2. **单点风险**: Server4 内存满载 (0GB剩余)，无法弹性扩容
3. **HDD浪费**: Server3 的 64GB/16核 大部分闲置
4. **降级困难**: Server4 宕机后无完美迁移方案

### 优化建议

```
1. 短期:
   - 将 Notification 迁移到 Server3，释放 Server1 资源
   - Server4 内存升级到 24GB，留 8GB buffer

2. 长期:
   - Server3 SSD 改造，提升 Zone-B 吸引力
   - 考虑 User/Notification 多副本部署
```

---

**部署决策树**:
```
Search(32GB) → 仅 Server1/2/3 可用，选 Server2 (Zone-A, SSD)
Analytics(8核) → 选 Server1 (16核，满足高核偏好)
API(Cache同Zone, SSD, Zone-A) → Server1
Cache(同API Zone, SSD) → Server1 (Zone-A)
Order(SSD, ≠Payment) → Server4 (避免与Server2 Payment冲突)
Payment(SSD, ≠Order) → Server2
User/Notification → Server3 (剩余资源池)
```