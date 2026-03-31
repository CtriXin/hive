## 1. 部署方案分析

### 硬约束推理：

**Zone-A 约束：**
- API Gateway 必须在 Zone-A (Server1/Server2，都需要 SSD) → Server1 或 Server2
- Cache Service 必须和 API Gateway 同 Zone → 也在 Zone-A

**Zone-B 约束：**
- Server3 是 HDD，只能部署不需要 SSD 的服务
- Server4 是 SSD，可以部署需要/不需要 SSD 的服务

**资源匹配：**
- Analytics Service (8核, 16GB, 不需要SSD) → 只能放 Server1 或 Server3
- Order Service 和 Payment Service (各4核, 都需要SSD) → 只能放 Server1, Server2, Server4
- Search Service (4核, 32GB, 不需要SSD) → 需要32GB内存，只能放 Server1, Server3
- Cache Service (2核, 16GB, 需要SSD) → 只能放 Server1, Server2, Server4

## 2. 完整部署方案

### **Server1 (Zone-A, 16核/64GB, SSD)**
- **API Gateway** (4核, 8GB, SSD, Zone-A必需)
- **Analytics Service** (8核, 16GB, 优先高核数)
- **Cache Service** (2核, 16GB, SSD, 与API Gateway同Zone)

**资源使用:** CPU: 14/16 (87.5%), 内存: 40/64GB (62.5%)

### **Server2 (Zone-A, 8核/32GB, SSD)**
- **Order Service** (4核, 16GB, SSD)

**资源使用:** CPU: 4/8 (50%), 内存: 16/32GB (50%)

### **Server3 (Zone-B, 16核/64GB, HDD)**
- **Search Service** (4核, 32GB, 不需要SSD, 需要大内存)
- **User Service** (2核, 4GB, 不需要SSD)
- **Notification Service** (1核, 2GB, 不需要SSD)

**资源使用:** CPU: 7/16 (43.75%), 内存: 38/64GB (59.4%)

### **Server4 (Zone-B, 8核/16GB, SSD)**
- **Payment Service** (4核, 8GB, SSD, 不能与Order Service同服务器)

**资源使用:** CPU: 4/8 (50%), 内存: 8/16GB (50%)

## 3. 约束满足情况检查

### 硬约束验证：

| 约束 | 状态 | 验证 |
|------|------|------|
| 1. CPU/内存不超限 | ✅ | 所有服务器资源使用率 ≤ 87.5% |
| 2. SSD服务不部署HDD | ✅ | API Gateway, Order, Payment, Cache 都在SSD服务器 |
| 3. Zone约束满足 | ✅ | API Gateway在Zone-A, Cache在Zone-A |
| 4. Order≠Payment | ✅ | Order在Server2, Payment在Server4 |
| 5. Cache与API Gateway同Zone | ✅ | 都在Zone-A |

### 软约束满足：

| 软约束 | 状态 | 说明 |
|--------|------|------|
| 6. Analytics优先高核数 | ✅ | 部署在Server1 (16核) |
| 7. 负载平衡 | ⚠️ | Server1负载最高(87.5%), 其他40-50% |
| 8. 同Zone通信优化 | ⚠️ | API Gateway和Cache同Zone, 但其他服务跨Zone |

## 4. Server4 宕机降级方案

### 方案A：紧急迁移（优先）
**迁移 Payment Service 到 Server2**
- Server2原负载: CPU 4/8 (50%), 内存 16/32GB (50%)
- 迁移后: CPU 8/8 (100%), 内存 24/32GB (75%)
- 违反Order≠Payment约束，需降级运行

**降级措施：**
1. 开启熔断器，限制 Payment Service 访问频率
2. 延迟非关键支付操作到夜间处理
3. 启用备份队列缓冲支付请求

### 方案B：临时下线 Payment Service
- 仅支持已完成支付订单查询
- 新订单进入等待队列
- 预计影响：无法处理新支付请求

### 方案C：横向扩容（需准备时间）
- 在Server1创建Payment Service实例
- Server1负载将达到: CPU 18/16 (超载), 内存 48/64GB
- 需要限流降级Analytics Service

**推荐：** 方案A + 临时限流，尽快恢复Server4

## 5. 方案优劣分析

### 优势：
✅ **所有硬约束满足** - 无违规部署  
✅ **Zone-A关键服务同区** - API Gateway + Cache 低延迟  
✅ **高核数利用** - Analytics Service充分利用Server1  
✅ **预留资源** - Server2/4各留50%缓冲，Server3留43%  
✅ **SSD服务正确隔离** - 避免HDD性能瓶颈  

### 劣势：
⚠️ **Server1负载过高** - 87.5% CPU使用率，故障风险高  
⚠️ **跨Zone通信多** - Order/Payment在不同Zone，延迟增加  
⚠️ **Server3资源浪费** - 16核HDD只用了7核，但无法部署SSD服务  
⚠️ **Server4利用率低** - 仅运行Payment，存在资源闲置  

### 优化建议：
1. **增加Server2容量** (12核/48GB) - 可以分担Analytics Service部分负载
2. **部署双活实例** - API Gateway和Payment Service跨区冗余
3. **动态调度** - 根据实时负载迁移部分服务到空闲资源

方案已完成。核心策略是在硬约束满足的前提下，优先满足关键服务的Zone要求和资源需求，通过Server1承担高核数任务，为其他服务器预留充足的应急资源。