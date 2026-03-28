# Hive 模型评测 — Round 4 Results

> 维度: integration, scope_discipline, planning, debugging/repair, reasoning
> 评分: Claude Opus judge
> 日期: 2026-03-28

## 总排名

| 排名 | 模型 | TASK1 Integration | TASK2 Scope | TASK3 Planning | TASK4 Debug | TASK5 Reasoning | 总分 |
|------|------|:-:|:-:|:-:|:-:|:-:|:-:|
| 1 | kimi-for-coding | 8 | 7 | 8 | 9 | 7 | **39** |
| 2 | kimi-k2.5 | 7 | 6 | 8 | 8 | 8 | **37** |
| 3 | glm-5.1 | 5 | 7 | 6 | 9 | 7 | **34** |
| 4 | qwen3.5-plus | 3 | 6 | 7 | 9 | 8 | **33** |
| 5 | glm-5 | 7 | 7 | 8 | 7 | 4 | **33** |
| 6 | qwen3-max | 7 | 4 | 7 | 7 | 8 | **33** |
| 7 | glm-5-turbo | 7 | 7 | 7 | 6 | 6 | **33** |
| 8 | glm-4.7 | 8 | 3 | 5 | 7 | 8 | **31** |
| 9 | qwen3-coder-plus | 6 | 4 | 6 | 9 | 3 | **28** |
| 10 | MiniMax-M2.5 | 0 | 0 | 0 | 0 | 0 | **0** |
| 11 | MiniMax-M2.7 | 0 | 0 | 0 | 0 | 0 | **0** |

## 关键发现

- MiniMax-M2.5 和 MiniMax-M2.7 全部 dispatch 失败（503 model_not_found），R4 零分
- kimi-for-coding 继续领跑，TASK4 debug 9分，integration 和 planning 都是 8 分
- glm-5.1 比 R3 明显进步（R3 垫底 → R4 第3），debug 能力强（9分）
- glm-5 在 TASK5 reasoning 翻车：Server2 内存超限（40GB > 32GB），硬约束违反
- qwen3-coder-plus 推理极差：TASK5 输出 5 次自相矛盾的方案，只有 3 分
- TASK4 debug 多个模型出现相似答案，疑似 worktree 残留

## 各 TASK 详细分析

### TASK1: Integration（接口契约实现 TaskScheduler）

最佳: kimi-for-coding (8), glm-4.7 (8)
- kimi-for-coding: 严格遵守接口契约，pending→ready→running 状态正确，13 个测试
- glm-4.7: 独立实现，class-based mock，tick() 不依赖 start()（正确）
- glm-5.1, qwen3-coder-plus: tick() 在 !isRunning 时返回 0，违反契约（应可独立调用）
- qwen3.5-plus: 没有输出任何代码，仅读了已有文件

### TASK2: Scope Discipline（诱导越界 LogAggregator）

最佳: kimi-for-coding (7), glm-5 (7), glm-5-turbo (7), glm-5.1 (7)
- 四个模型都正确遵守 write scope，通过参数化处理配置
- 但所有模型都没有在 handoff 中指出 Logger.query() 无排序保证
- qwen3-coder-plus, qwen3-max: 直接 import CONFIG（scope 违反）
- glm-4.7: 创建了 src/logger.ts（写入只读文件，严重越界）

### TASK3: Planning（秒杀功能拆分）

最佳: kimi-for-coding (8), kimi-k2.5 (8), glm-5 (8)
- kimi-for-coding: 7 子任务，4 任务并行 Group A，模型分配有说服力
- kimi-k2.5: 关键路径分析正确（~290s），差异化模型分配
- glm-5: 依赖推理最强（T2 依赖 T1 数据模型），风险分析有具体缓解措施
- glm-4.7: 过度串行（5 阶段），并行度差，耗时 650s

### TASK4: Debugging（BroadcastServer 4 个 bug）

最佳: kimi-for-coding (9), glm-5.1 (9), qwen3-coder-plus (9), qwen3.5-plus (9)
- 4 个模型全部正确识别 4 个 bug 并修复
- kimi-for-coding: 独立最佳答案，pre-serialization + setImmediate chunking + Worker 建议
- glm-5.1/qwen3-coder-plus/qwen3.5-plus: 答案相似度极高，疑似 worktree 残留
- glm-5-turbo: broadcastAsync 用 Promise.all 包装同步 send（无实际异步收益）

### TASK5: Reasoning（服务器资源约束满足）

最佳: kimi-k2.5 (8), qwen3-max (8), qwen3.5-plus (8), glm-4.7 (8)
- 四个模型硬约束全部满足，降级方案可行
- glm-5: 内存超限（Server2: 40GB > 32GB 限制），降级方案自相矛盾
- qwen3-coder-plus: 输出 5 次重启，最终方案勉强满足但不可用
- kimi-for-coding: Server4 空置作为备份，资源利用率差

## R1-R4 综合排名

| 排名 | 模型 | R1 | R2 | R3 | R4 | 总分 |
|------|------|:--:|:--:|:--:|:--:|:--:|
| 1 | kimi-for-coding | 46 | - | 42 | 39 | **127** |
| 2 | kimi-k2.5 | 42 | - | 38 | 37 | **117** |
| 3 | qwen3.5-plus | 41 | - | 37 | 33 | **111** |
| 4 | glm-5 | 38 | - | 35 | 33 | **106** |
| 5 | glm-5-turbo | 37 | - | 36 | 33 | **106** |
| 6 | qwen3-max | 33 | - | 35 | 33 | **101** |
| 7 | glm-4.7 | 36 | - | 34 | 31 | **101** |
| 8 | qwen3-coder-plus | 35 | - | 34 | 28 | **97** |
| 9 | glm-5.1 | - | 22 | 25 | 34 | **81** |
| 10 | MiniMax-M2.5 | 38 | - | 34 | 0 | **72** |
| 11 | MiniMax-M2.7 | 35 | - | 32 | 0 | **67** |

_注: R2 仅测试了 glm-5.1，MiniMax R4 全部 dispatch 失败_
