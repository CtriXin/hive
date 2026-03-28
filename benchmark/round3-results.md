# Hive Round 3 评审报告 — Claude Opus 评审

> 评审委：Claude Opus 4.6
> 评审日期：2026-03-28
> 方法：逐份原始答卷审查，对照评分标准独立打分
> 参评模型：11 个（含新增 glm-5.1）
> 满分：50 分（5 TASK × 10 分）

---

## 一、总分排名

| 排名 | 模型 | TASK1 Implementation | TASK2 Review | TASK3 Spec | TASK4 Repair | TASK5 Translation | **总分/50** |
|:---:|------|:---:|:---:|:---:|:---:|:---:|:---:|
| 1 | **kimi-for-coding** | 7.5 | 6.0 | 9.5 | 9.0 | 9.5 | **41.5** |
| 2 | **kimi-k2.5** | 7.5 | 6.0 | 8.0 | 8.0 | 9.5 | **39.0** |
| 3 | **qwen3.5-plus** | 7.5 | 5.5 | 9.0 | 7.5 | 8.5 | **38.0** |
| 4 | **glm-5-turbo** | 7.5 | 5.5 | 8.5 | 6.5 | 8.5 | **36.5** |
| 5 | **qwen3-max** | 7.5 | 5.5 | 7.5 | 7.0 | 8.5 | **36.0** |
| 6 | **glm-5** | 6.0 | 5.0 | 7.0 | 7.0 | 9.0 | **34.0** |
| 7 | **glm-4.7** | 6.0 | 3.5 | 8.5 | 5.5 | 8.5 | **32.0** |
| 8 | **MiniMax-M2.7** | 5.5 | 5.5 | 8.0 | 5.0 | 7.5 | **31.5** |
| 9 | **qwen3-coder-plus** | 7.0 | 4.5 | 5.5 | 6.5 | 7.5 | **31.0** |
| 10 | **glm-5.1** | 5.0 | 5.0 | 5.5 | 5.5 | 8.0 | **29.0** |
| 11 | **MiniMax-M2.5** | 6.0 | 3.0 | 6.0 | 4.0 | 8.0 | **27.0** |

---

## 二、各 TASK 详细评审

### TASK1: Implementation — RetryQueue（实现能力）

**共性问题：** 并发控制是最大分化点。多数模型在 backoff 等待期间占用并发槽位（slot held during backoff），降低了有效并发。

| 模型 | 分数 | 关键评语 |
|------|:---:|---------|
| kimi-for-coding | 7.5 | 并发池正确（runningCount + pendingQueue），退避有 cap，6 个测试覆盖全 |
| kimi-k2.5 | 7.5 | cancel-during-execution 检查好，8 个测试。但 onComplete 只存单个回调，backoff 期间占槽 |
| glm-5-turbo | 7.5 | 工具函数抽取好，destroy() 方法加分，8 个测试含时序验证。但 tasks.delete() 导致 getStatus 返回 undefined |
| qwen3-max | 7.5 | Promise-based 测试等待更健壮，cancel 有清理。backoff 期间占槽，O(n) 扫描 |
| qwen3.5-plus | 7.5 | **唯一正确释放 retry 槽位的实现**（timer → re-enqueue → processQueue），finally 模式干净 |
| qwen3-coder-plus | 7.0 | Jest fake timer 测试较专业，但 onComplete 单回调，fake timer + async 组合脆弱 |
| glm-5 | 6.0 | Promise 缺类型参数（编译错误），activeCount 有双减风险 |
| glm-4.7 | 6.0 | await handleRetry 阻塞 finally，导致 backoff 全程占槽。首次执行状态错设为 'retrying' |
| MiniMax-M2.5 | 6.0 | processQueue 中 cancelled 分支泄漏 running++ 永不释放 |
| MiniMax-M2.7 | 5.5 | 'running' 不在 TaskStatus union 中（TS 编译错误），cancel 触发 onComplete('failed') 语义错 |
| glm-5.1 | 5.0 | **未提供任何测试用例**——直接违反题目硬性要求 |

### TASK2: Code Review — DistributedLockManager Bug Finding（审查能力）

**共性问题：**
- **无一模型找到 BUG 1**（off-by-one retry 语义）和 **BUG 3**（timer key 碰撞）
- BUG 2（过期判断反转）、BUG 4（setTimeout 构造错误）、BUG 5（release 无 owner 检查）几乎所有模型都找到
- **常见误报：** "default parameter 对象引用共享"——JS/TS 中默认参数每次调用重新求值，这不是 bug

| 模型 | 分数 | 找到 Bug | 误报 | 关键评语 |
|------|:---:|---------|------|---------|
| kimi-for-coding | 6.0 | 2,4,5,6 (4/6) | 1 | 代码中意外修复了 BUG 1 但未识别。误报 race condition |
| kimi-k2.5 | 6.0 | 2,4,5,6 (4/6) | 1 | timer callback 检查 owner 部分覆盖 BUG 3 思路。代码整洁 |
| glm-5-turbo | 5.5 | 2,4,5,6 (4/6) | 1 | 修复代码质量好。误报 default param |
| MiniMax-M2.7 | 5.5 | 2,4,5,6 (4/6) | 1 | helper 方法结构好。timer 相关 bug 4&5 与 BUG 3 方向不同 |
| qwen3-max | 5.5 | 2,4,5 (3/6 显式) | 1 | 修复代码实际覆盖 5/6（代码比文字强），误报 default param |
| qwen3.5-plus | 5.5 | 2,4,5,6 (4/6) | 1 | release 的 owner 改为 optional 反而架空了检查 |
| glm-5 | 5.0 | 2,4,5,6 (4/6) | 1 | **BUG 4（setTimeout）严重性分类为 low——明显错误** |
| glm-5.1 | 5.0 | 2,4,5,6 (4/6) | 2 | getLockInfo 未修复，BUG 6 识别模糊 |
| qwen3-coder-plus | 4.5 | 2,4,5 (3/6) | 1 | release 的 owner 改 optional 架空检查。BUG 6 在代码中修了但未列为 finding |
| glm-4.7 | 3.5 | 2,4,5 (3/6) | 2 | Bug 4 疑似 Bug 2 重复。修复代码有错（release 调用缺 owner 参数），isLocked 未修 |
| MiniMax-M2.5 | 3.0 | 4,5 (2/6) | 2 | 漏掉反转过期判断（在代码中静默修了但未列为 bug）。修复引入新 bug（break 导致获锁失败） |

### TASK3: Spec Adherence — 矛盾文档路由（规格遵从）

**3 个冲突点：**
1. 路由优先级：精确 > 参数 > 通配符（A 勘误覆盖 B）
2. 超时单位：毫秒，默认 30000ms（A 覆盖 C 的"秒"）
3. 404 响应体：必须含 path 字段（A 补充 C 遗漏）

| 模型 | 分数 | 冲突 1 | 冲突 2 | 冲突 3 | 注释质量 | 关键评语 |
|------|:---:|:---:|:---:|:---:|---------|---------|
| kimi-for-coding | 9.5 | ✅ | ✅ | ✅ | 优秀（每处标注） | 三个冲突全部正确解决，内联注释标注决策，测试含超时默认值验证 |
| qwen3.5-plus | 9.0 | ✅ | ✅ | ✅ | 优秀（冲突解决日志） | 顶部"CONFLICT RESOLUTION LOG"清晰列举所有冲突 |
| glm-5-turbo | 8.5 | ✅ | ✅ | ✅ | 好（内联注释） | 三桶路由结构清晰。minor: `_regex` hack |
| glm-4.7 | 8.5 | ✅ | ✅ | ✅ | 优秀（头部注释） | 头部文档列举 3 个冲突和解决方案，含中间件支持 |
| kimi-k2.5 | 8.0 | ✅ | ✅ | ✅ | 较少（仅类型注释） | 逻辑正确但内联冲突注释不足 |
| MiniMax-M2.7 | 8.0 | ✅ | ✅ | ✅ | 好 | 4 个聚焦测试覆盖好。但超时未实际执行（同步 handler） |
| qwen3-max | 7.5 | ✅ | ✅ | ✅ | 仅一行 | 实现正确，Promise.race 超时好。注释几乎没有 |
| glm-5 | 7.0 | ✅ | ✅ | ✅ | 差（仅一行头部） | 实现正确但无 30000ms 默认值，注释不足 |
| MiniMax-M2.5 | 6.0 | ✅ | ❌ | ✅ | 好 | **超时用 30ms 而非 30000ms**——理解了单位是毫秒但没做换算 |
| glm-5.1 | 5.5 | ✅ | ❌ | ✅ | 简短 | 注释声称毫秒但测试用 `timeout: 30`（矛盾）。超时 race 因同步 handler 失效 |
| qwen3-coder-plus | 5.5 | ✅ | ✅ | ✅ | **无** | 零注释。handleRequest 有运行时 bug。测试不覆盖 404/超时 |

### TASK4: Repair — ConnectionPool 修复（修复 + 范围纪律）

**4 项 Finding：**
1. [RED] 等待队列替代抛异常
2. [YELLOW] release 验证 conn 归属
3. [YELLOW] drain 等待活跃连接 / force 参数
4. [RED] 健康检查 validate 函数

| 模型 | 分数 | F1 | F2 | F3 | F4 | 向后兼容 | 注释标注 | 关键评语 |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|---------|
| kimi-for-coding | 9.0 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 全部正确，FIFO 队列，清洁代码，4 个测试 |
| kimi-k2.5 | 8.0 | ✅ | ✅(静默) | ✅ | ✅ | ✅ | ✅ | 扎实。F2 用静默返回而非抛错。测试 runner 有语法错误 |
| qwen3.5-plus | 7.5 | ⚠️ | ✅ | ✅(最佳) | ✅ | ✅ | ✅ | **最佳 drain 实现**（事件驱动无轮询）。但 F1 waiter 交接漏加 inUse |
| glm-5 | 7.0 | ✅ | ✅(静默) | ✅ | ✅ | ⚠️ | ✅ | 泛型类型缺失。Test 4 有 const 重赋值 bug |
| qwen3-max | 7.0 | ✅ | ✅ | ✅(脆弱) | ✅(仅同步) | ✅ | ✅ | 注释最好（含 severity 标签）。drain 用 monkey-patch，validate 仅同步 |
| glm-5-turbo | 6.5 | ⚠️ | ✅(静默) | ✅ | ✅ | ✅ | ✅ | **release→waiter 漏 inUse.add()**。drain 给 waiter 发 null |
| qwen3-coder-plus | 6.5 | ✅ | ✅(静默) | ✅ | ✅ | ✅ | ❌ | **无 Finding 编号注释**。force drain 静默丢弃 waiter |
| glm-5.1 | 5.5 | ✅ | ✅(静默) | ✅(脆弱) | ✅(递归) | ❌ | ✅ | **向后兼容破坏**（PoolOptions 新 API）。monkey-patch release |
| glm-4.7 | 5.5 | ✅ | ✅(静默) | ✅ | ❌(setter) | ⚠️ | ✅ | validate 用 setter 而非构造参数——API 不符。范围蔓延（getStatus） |
| MiniMax-M2.7 | 5.0 | ✅ | ✅ | ⚠️(无force) | ❌(per-acquire) | ⚠️ | ✅ | F3 缺 force 参数。F4 validate 放在 acquire 参数而非构造函数 |
| MiniMax-M2.5 | 4.0 | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | **F1 等待队列有致命 bug**：递归 acquire 死锁，released conn 卡在 inUse |

### TASK5: Translation — CQRS 三语翻译（翻译基线）

**共性表现：** 整体水平较高，无模型出现中文字符泄漏到日文。主要分化点在日文术语选择和英文大写规范。

| 模型 | 分数 | 关键评语 |
|------|:---:|---------|
| kimi-for-coding | 9.5 | 三语全优，术语一致，回译高度还原，含括号英文注释 |
| kimi-k2.5 | 9.5 | 与 kimi-for-coding 并列最佳。業務ロールバック 比 ビジネスロールバック 更自然 |
| glm-5 | 9.0 | 三语准确流畅。コマンドサイド 变体可接受 |
| glm-5-turbo | 8.5 | 扎实。singular "a Materialized View" 小瑕疵 |
| glm-4.7 | 8.5 | 简洁准确。省略"for processing"但不影响语义 |
| qwen3-max | 8.5 | **日文 である 体最佳**（正式技术文档风格） |
| qwen3.5-plus | 8.5 | 均衡。英文正确大写术语。"latency" 替代 "delay" 可接受 |
| glm-5.1 | 8.0 | 日文用 **実体化ビュー** 而非标准片假名 マテリアライズドビュー |
| MiniMax-M2.5 | 8.0 | 日文缺括号注释，降低技术可读性 |
| MiniMax-M2.7 | 7.5 | 日文 **イベントソース**（事件源）而非 イベントソーシング（事件溯源）——语义偏差 |
| qwen3-coder-plus | 7.5 | 日文 **最終的一貫性** 非标准（应为 結果整合性/最終整合性） |

---

## 三、维度能力分析

基于 Round 3 五个 TASK 的表现，各模型的维度能力画像：

| 模型 | Implementation | Review | Spec Adherence | Repair | Translation | **综合** |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| kimi-for-coding | ★★★ | ★★☆ | ★★★★ | ★★★★ | ★★★★ | **最强全能型** |
| kimi-k2.5 | ★★★ | ★★☆ | ★★★ | ★★★ | ★★★★ | 全能型，略弱于 kimi-fc |
| qwen3.5-plus | ★★★ | ★★☆ | ★★★★ | ★★★ | ★★★ | **spec 遵从最佳之一** |
| glm-5-turbo | ★★★ | ★★☆ | ★★★ | ★★☆ | ★★★ | 均衡但 repair 有短板 |
| qwen3-max | ★★★ | ★★☆ | ★★★ | ★★★ | ★★★ | **R3 表现远超 R1/R2 排名** |
| glm-5 | ★★☆ | ★★ | ★★★ | ★★★ | ★★★★ | 翻译强，实现偏弱 |
| glm-4.7 | ★★☆ | ★☆ | ★★★ | ★★☆ | ★★★ | spec 好但 review 是最大短板 |
| MiniMax-M2.7 | ★★ | ★★☆ | ★★★ | ★★ | ★★ | 中等偏下 |
| qwen3-coder-plus | ★★★ | ★☆ | ★★ | ★★☆ | ★★ | 编码快但 spec/review 弱 |
| glm-5.1 | ★★ | ★★ | ★★ | ★★ | ★★★ | **新模型，全面低于 glm-5** |
| MiniMax-M2.5 | ★★☆ | ★ | ★★☆ | ★ | ★★★ | review + repair 是致命弱点 |

---

## 四、关键发现

### 1. Review 能力普遍偏弱
Round 3 TASK2 平均分仅 **4.95/10**，是五个维度中最低的。没有任何模型找全 6 个 bug，特别是：
- **BUG 1（off-by-one retry 语义）：0/11 找到** — 最微妙的语义 bug
- **BUG 3（timer key 碰撞）：0/11 找到** — 多方竞争场景的推理缺失
- 常见误报"default parameter 共享"出现在 4 个模型中

### 2. kimi-for-coding 持续领跑
三轮总计（R1 Opus + R2 GLM + R3 Opus）：
- R1: 37.5 / R2: 41.6 / R3: 41.5 → **Combined: 120.6**
- 唯一在 spec_adherence + repair 同时拿到 9+ 的模型

### 3. qwen3.5-plus 是最大黑马
- R1+R2 排名第 5，但 R3 跃升至第 3
- spec 遵从（9.0）和翻译（8.5）表现突出
- 之前被低估，建议上调 model-capabilities 分数

### 4. glm-5.1 新模型表现不及预期
- 总分 29.0，低于 glm-5（34.0）和 glm-5-turbo（36.5）
- TASK1 无测试、TASK3 超时矛盾、TASK4 破坏向后兼容
- 暂不建议加入 Hive 正式候选，等后续版本稳定

### 5. MiniMax 系列 repair 能力告急
- M2.5 TASK4 仅 4.0（等待队列死锁 bug）
- M2.7 TASK4 仅 5.0（force 缺失 + validate API 错位）
- 不建议分配 repair 类子任务给 MiniMax 模型

---

## 五、R1+R2+R3 综合排名

| 排名 | 模型 | R1 (Opus) | R2 (GLM) | R3 (Opus) | **综合** |
|:---:|------|:---:|:---:|:---:|:---:|
| 1 | **kimi-for-coding** | 37.5 | 41.6 | 41.5 | **120.6** |
| 2 | **kimi-k2.5** | 34.0 | 40.8 | 39.0 | **113.8** |
| 3 | **qwen3.5-plus** | 34.5 | 39.0 | 38.0 | **111.5** |
| 4 | **glm-5-turbo** | 29.5 | 38.8 | 36.5 | **104.8** |
| 5 | **glm-5** | 35.0 | 39.6 | 34.0 | **108.6** |
| 6 | **qwen3-max** | 26.0 | 38.0 | 36.0 | **100.0** |
| 7 | **glm-4.7** | 36.0 | 36.2 | 32.0 | **104.2** |
| 8 | **MiniMax-M2.7** | 34.5 | 33.6 | 31.5 | **99.6** |
| 9 | **MiniMax-M2.5** | 33.5 | 40.5 | 27.0 | **101.0** |
| 10 | **qwen3-coder-plus** | 31.5 | 41.5 | 31.0 | **104.0** |
| 11 | **glm-5.1** | — | — | 29.0 | **29.0** (仅 1 轮) |

> 注：R2 由 glm-5-turbo 评审，存在已知偏差（glm 系高估 ~1-2 分）。综合排名仅供参考，R4/R5 后可用加权公式。

---

## 六、model-capabilities.json 调分建议

基于 R3 实测数据，建议以下调整：

| 模型 | 维度 | 现值 | 建议值 | R3 证据 |
|------|------|:---:|:---:|---------|
| qwen3.5-plus | general | 0.87 | **0.90** | R3 总分第 3，spec 9.0，综合表现一直被低估 |
| qwen3.5-plus | review | 0.80 | **0.82** | TASK2 5.5 虽不高但属正常区间，非短板 |
| qwen3-max | coding | 0.55 | **0.65** | TASK1 7.5（与 kimi 并列），R1 的 3 分是极端异常值 |
| qwen3-max | general | 0.78 | **0.82** | R3 总分 36.0 位列第 5，稳定提升 |
| glm-4.7 | review | 0.78 | **0.70** | TASK2 仅 3.5（最低档之一），review 是明确短板 |
| MiniMax-M2.5 | review | 0.78 | **0.65** | TASK2 仅 3.0，TASK4 仅 4.0，修复+审查双弱 |
| MiniMax-M2.5 | coding | 0.85 | **0.78** | TASK1 6.0，TASK4 等待队列致命 bug |
| MiniMax-M2.7 | coding | 0.78 | **0.72** | TASK1 5.5（TS 类型错误），TASK4 5.0 |
| qwen3-coder-plus | review | 0.70 | **0.65** | TASK2 4.5，TASK3 无注释（spec_adherence 弱） |
| glm-5.1 | — | (新增) | **暂缓** | 全面低于 glm-5，等后续评测 |

---

## 七、对 Hive profiler 的映射建议

按 Round 3 scorecard 公式映射后的 ProfileScoreKey 估值（0-1 标准化）：

| 模型 | implementation | review | repair | spec_adherence | scope_discipline | translation |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| kimi-for-coding | 0.75 | 0.60 | 0.90 | 0.95 | 0.90 | 0.95 |
| kimi-k2.5 | 0.75 | 0.60 | 0.80 | 0.80 | 0.85 | 0.95 |
| qwen3.5-plus | 0.75 | 0.55 | 0.75 | 0.90 | 0.85 | 0.85 |
| glm-5-turbo | 0.75 | 0.55 | 0.65 | 0.85 | 0.80 | 0.85 |
| qwen3-max | 0.75 | 0.55 | 0.70 | 0.75 | 0.80 | 0.85 |
| glm-5 | 0.60 | 0.50 | 0.70 | 0.70 | 0.75 | 0.90 |
| glm-4.7 | 0.60 | 0.35 | 0.55 | 0.85 | 0.70 | 0.85 |
| MiniMax-M2.7 | 0.55 | 0.55 | 0.50 | 0.80 | 0.65 | 0.75 |
| qwen3-coder-plus | 0.70 | 0.45 | 0.65 | 0.55 | 0.60 | 0.75 |
| glm-5.1 | 0.50 | 0.50 | 0.55 | 0.55 | 0.55 | 0.80 |
| MiniMax-M2.5 | 0.60 | 0.30 | 0.40 | 0.60 | 0.70 | 0.80 |

> 注：这些分数基于单轮（R3）数据。建议 R4/R5 完成后取加权平均。
