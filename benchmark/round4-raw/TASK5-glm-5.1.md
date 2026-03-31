## 微服务部署方案

### 1. 部署方案

| 服务器 | 部署服务 |
|--------|----------|
| **Server1** (16C/64G/SSD/Zone-A) | API Gateway, Cache Service, Analytics Service |
| **Server2** (8C/32G/SSD/Zone-A) | Payment Service, Notification Service |
| **Server3** (16C/64G/HDD/Zone-B) | Search Service, User Service |
| **Server4** (8C/16G/SSD/Zone-B) | Order Service |

### 2. 资源使用情况

| 服务器 | CPU 使用 | CPU 剩余 | 内存使用 | 内存剩余 | 磁盘 |
|--------|----------|----------|----------|----------|------|
| **Server1** | 14/16 (87.5%) | 2核 | 40/64 (62.5%) | 24GB | SSD |
| **Server2** | 5/8 (62.5%) | 3核 | 10/32 (31.3%) | 22GB | SSD |
| **Server3** | 6/16 (37.5%) | 10核 | 36/64 (56.3%) | 28GB | HDD |
| **Server4** | 4/8 (50%) | 4核 | 16/16 (100%) | 0GB | SSD |

**总计**: 29/48 CPU (60.4%), 102/176 内存 (58.0%)

### 3. 约束逐条验证

| # | 约束 | 状态 | 验证 |
|---|------|------|------|
| 1 | CPU/内存不超限 | ✅ | 所有服务器均在限额内 |
| 2 | SSD 服务不在 HDD 上 | ✅ | API Gateway(Zone-A SSD), Order(S4-SSD), Payment(S2-SSD), Cache(S1-SSD) 均在 SSD |
| 3 | API Gateway 在 Zone-A | ✅ | 部署在 Server1 (Zone-A) |
| 4 | Order ≠ Payment 同服务器 | ✅ | Order→S4, Payment→S2 |
| 5 | Cache 与 API Gateway 同 Zone | ✅ | Cache→S1, API Gateway→S1，同 Zone-A |
| 6 | Analytics 优先高核数 | ✅ | 部署在 16 核的 Server1 |
| 7 | 负载均衡 | ⚠️ | Server1 偏高(87.5% CPU)，但未超限；整体可接受 |
| 8 | 相关服务同 Zone | ✅ | API+Cache+Payment 同 Zone-A，减少延迟 |

### 4. Server4 宕机降级方案

Server4 上运行 **Order Service** (4C/16G/SSD)。降级策略：

**首选迁移 → Server1**（剩余 2C/24G）
- 问题：CPU 不足（需 4 核，仅剩 2 核）
- 方案：将 Analytics Service 从 Server1 降级/弹性缩容（8C→6C），腾出空间给 Order Service
- 迁移后 Server1: API(4) + Cache(2) + Analytics(6) + Order(4) = 16/16 CPU, 56/64 内存 ✅

**备选迁移 → Server2**（剩余 3C/22G）
- 问题：CPU 不足（需 4 核，仅剩 3 核）
- 方案：Order Service 弹性缩容至 3 核后迁入
- 迁移后 Server2: Payment(4) + Notification(1) + Order(3) = 8/8 CPU, 26/32 内存 ✅

**推荐方案**：首选迁移到 Server1，通过 Analytics Service 弹性缩容实现，保持 Zone-A 内闭环，且 Order Service 需要的 SSD 条件满足。

**降级期间影响**：
- Analytics Service 性能略降（6 核 vs 8 核）
- Order Service 无性能损失
- 其他服务不受影响

### 5. 方案优劣分析

**优势**：
- 所有硬约束 100% 满足
- Analytics Service 落在最高核数服务器（16C），最优利用 CPU 密集型特征
- API Gateway + Cache + Payment 同 Zone-A，关键链路延迟最低
- Server4 宕机时有明确降级路径，无需跨 Zone 调度
- Search Service 在 HDD 服务器上无影响（不需要 SSD），充分利用异构资源

**不足**：
- Server1 CPU 负载偏高（87.5%），峰值时可能成为瓶颈
- Server4 内存打满（100%），无余量应对突发
- Server3 负载偏低（37.5% CPU），资源未充分利用，但因 HDD 限制无法接收 SSD 依赖服务
- 如果未来新增服务，Server4 的扩展空间最小

**改进建议**：
- 可考虑将 Server3 升级为 SSD，使调度更灵活
- 为 Server4 扩容内存至 32GB 以留出缓冲
- Server1 可设置自动弹性伸缩，CPU 超过 80% 时触发告警