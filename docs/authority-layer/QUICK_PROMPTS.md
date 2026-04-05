# Authority Layer Quick Prompts

Date: 2026-04-05
Status: copy-ready
Owner: codex-planner

Use these prompts when you want a short version for fast parallel sessions.

Shared reading set for all sessions:

- `docs/authority-layer/README.md`
- `docs/authority-layer/CR0_EXECUTION.md`
- `docs/authority-layer/INITIAL_MODEL_SEEDS.md`

## Kimi

```text
请阅读：
- docs/authority-layer/README.md
- docs/authority-layer/CR0_EXECUTION.md
- docs/authority-layer/INITIAL_MODEL_SEEDS.md

你现在是 Hive authority-layer CR0 的主审 reviewer。

任务：
审查这套“用 committee + Codex synthesis 替代单点 Claude authority”的方案。

重点看：
1. review authority topology 是否合理
2. 默认应该 single 还是 pair
3. escalation trigger 是否够稳
4. Codex synthesis 应该如何收束 disagreement
5. 哪些设计会伤害 calibration

输出要求：
1. verdict: keep / adjust / reject
2. top 5 必改建议
3. 推荐默认模式：single 或 pair
4. blockers vs defer
5. 你建议的最稳 review authority 方案

不要泛泛而谈，尽量给可执行结论。
```

## GLM

```text
请阅读：
- docs/authority-layer/README.md
- docs/authority-layer/CR0_EXECUTION.md

你现在是 Hive authority-layer CR0 的 adversarial architect。

任务：
从架构和风险角度攻击这套方案，找隐藏耦合、schema 膨胀、维护陷阱、对 Hive × AgentBus 主线的污染风险。

重点看：
1. 是否会打扰当前主线
2. 是否重复现有 Hive review / scorer / routing 机制
3. 是否会引入 config/schema sprawl
4. 最小安全 slice 应该多小
5. 哪些东西绝对不能进 CR0

输出要求：
1. 按严重度排序的 top 7 风险
2. 最小可行且安全的 CR0 slice
3. 明确 non-goals
4. 哪些 proposal 是 false expansion

请尽量尖锐，但要区分真 blocker 和过度设计。
```

## Mimo

```text
请阅读：
- docs/authority-layer/README.md
- docs/authority-layer/CR0_EXECUTION.md
- docs/authority-layer/INITIAL_MODEL_SEEDS.md

你现在是 Hive authority-layer CR0 的 implementation / lifecycle reviewer。

任务：
从工程实现角度，给出最 practical 的落地方案。

重点看：
1. 最小代码切入点
2. 应该改哪些文件
3. scorer / registry / orchestrator 分别怎么接
4. lifecycle / observability 怎么保持清晰
5. merge 前必须补哪些测试

输出要求：
1. 文件级 implementation plan
2. top lifecycle risks
3. must-have tests
4. 你建议第一批真正动手的文件列表

请偏工程化，不要只讲抽象方向。
```

## Qwen

```text
请阅读：
- docs/authority-layer/README.md
- docs/authority-layer/CR0_EXECUTION.md
- docs/authority-layer/INITIAL_MODEL_SEEDS.md

你现在是 Hive authority-layer CR0 的 checklist / coverage reviewer。

任务：
检查这套方案有没有漏掉 config、fallback、低置信度、off-path、disagreement、测试矩阵等关键边角。

重点看：
1. config 字段是否完整
2. fallback / skip / off path 是否定义清楚
3. disagreement handling 是否覆盖完整
4. low-confidence escalation 是否够清楚
5. smoke 前必须补哪些测试

输出要求：
1. 缺失 case 列表
2. must-test-before-smoke
3. nice-to-have tests
4. config/checklist 补充建议

请尽量完整，但注意区分 must-have 和 nice-to-have。
```

## GPT

```text
你现在是 Hive authority-layer CR0 的 review coordinator。

请阅读：
- docs/authority-layer/README.md
- docs/authority-layer/CR0_EXECUTION.md

我接下来会给你 4 份 memo，分别来自 Kimi / GLM / Mimo / Qwen。

任务：
把这 4 份评审综合成一份中立的 coordination memo，供 Codex 做最终 synthesis。

请输出：
1. points of agreement
2. real disagreements
3. probable false positives
4. 推荐的最小实现 slice
5. blockers
6. defer items
7. 需要 Codex 最终拍板的问题

要求：
- 不要简单投票
- 不要把 nice-to-have 误判成 blocker
- 尽量指出哪些意见和当前 CR0 目标一致，哪些已经 scope creep
```

