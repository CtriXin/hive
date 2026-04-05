# CR0 主审审查结论

**Reviewer**: kimi (主审)  
**Date**: 2026-04-05  
**Verdict**: `ADJUST` — 方向正确，需调整后再实施

---

## 1. 必改 Top 5

| # | 问题 | 修正方案 |
|---|------|----------|
| 1 | Escalation trigger 模糊 | 用客观指标替换主观描述：<br>`high_complexity` → `files_changed > 10`<br>`low_confidence` → `smoke_failed && review_passed` |
| 2 | Review output 无统一 schema | 强制格式：`{findings: [{severity, location, rationale}], confidence, coverage_gaps}` |
| 3 | Disagreement 检测太浅 | 新增：severity 差异 ≥2 级、同一文件 fix 冲突、漏检互补 |
| 4 | Seed weights 固化过快 | `effective_samples` 从 0.35 降至 0.15，前 5 次运行 3x 权重 |
| 5 | Deterministic 结果未定义 | smoke/build/test 作为 reviewer-0，拥有 veto 但不参与 synthesis |

---

## 2. 默认模式推荐：`SINGLE` + 条件升级

**Ladder 设计**：

```
single (kimi)
    ↓ [触发条件: 文件数>10 | 跨边界变更 | smoke失败 | confidence<0.7]
pair (+ mimo)
    ↓ [触发条件: disagreement未解决 | 风险标记]
jury (+ glm/qwen)
    ↓ [仍有分歧]
Codex synthesis
```

**Why not pair by default**：
- 成本 2x，但 Phase 3 数据显示 kimi single 已覆盖 70%+ 场景
- Pair 易导致 false positive 互相放大（reviewer 都想显得"有用"）

---

## 3. Blockers vs Defer

### Blockers（实施前必须解决）

- [ ] 统一 review output schema
- [ ] Disagreement 检测器具体实现（location + severity 双维度）
- [ ] Deterministic 层与 committee 的集成契约

### Defer（可后续迭代）

- [ ] model-lessons 自动更新闭环
- [ ] AgentBus-backed committee rooms（先用 direct dispatch）
- [ ] 动态预算控制

---

## 4. 推荐的最稳 Authority Topology

```
┌────────────────────────────────────┐
│  DETERMINISTIC LAYER (Reviewer-0)  │
│  smoke/build/test 结果，veto 权     │
└──────────────┬─────────────────────┘
               │
               ▼
┌────────────────────────────────────┐
│  POLICY ROUTER                     │
│  default: single (kimi)            │
│  escalate: 触发条件命中            │
└──────────────┬─────────────────────┘
               │
    ┌──────────┼──────────┐
    ▼          ▼          ▼
 [single]   [pair]    [jury]
    │          │          │
    └──────────┴──────────┘
               │
               ▼
┌────────────────────────────────────┐
│  DISAGREEMENT DETECTOR             │
│  输出: consensus | disputed | gap  │
└──────────────┬─────────────────────┘
               │
    ┌──────────┴──────────┐
    ▼                     ▼
[consensus]         [disputed]
    │                     │
    │                     ▼
    │            ┌────────────────┐
    │            │ Codex synthesis│
    │            │ - 标准化 severity  │
    │            │ - 合并冲突建议   │
    │            │ - 输出采纳/拒绝理由 │
    │            └───────┬────────┘
    │                     │
    └──────────┬──────────┘
               ▼
┌────────────────────────────────────┐
│  FINAL OUTPUT                      │
│  - verdict: PASS / NEEDS_FIX       │
│  - normalized findings             │
│  - disagreement log (for calib)    │
└────────────────────────────────────┘
```

---

## 5. Calibration 保护措施

1. **原始输出永久存档** — 用于后续 false positive 分析
2. **Codex 必须解释** — 对每位 reviewer 的采纳/部分采纳/拒绝理由
3. **每周回顾** — synthesis 结果 vs 实际 bug 发现率，调整 seed weights

---

## 6. 实施建议

1. **MVP 范围**：先跑通 single → pair 的 ladder，jury 可暂缓
2. **数据收集优先**：disagreement 率、false positive 率、Codex 修正率
3. **保持独立**：CR0 在独立 worktree 运行，不阻塞 AgentBus 主线
