# CR0 Coverage Checklist

Date: 2026-04-05
Reviewer: qwen3.5-plus

---

## 1. Config 缺失字段

### Must-have

```json
{
  "authority": {
    "review": {
      "escalation_thresholds": {
        "confidence": 0.5,
        "disagreement": "severity_diff >= 2 || conclusion_opposite"
      },
      "fallback_order": ["kimi-k2.5", "mimo-v2-pro", "qwen3.5-plus", "glm-5.1"],
      "budget_cap": { "single": 1, "pair": 2, "jury": 4 },
      "timeout_ms": 120000,
      "partial_result_policy": "proceed_if_min_met",
      "skip_conditions": ["deterministic_failed", "no_valid_reviewers"],
      "min_reviewers": { "single": 1, "pair": 2, "jury": 3 }
    }
  }
}
```

### Nice-to-have

- `severity_normalization`: 跨 model severity 对齐表
- `review_angles`: 分配不同审查角度避免重复
- `cache_key`: 相同变更复用历史 review

---

## 2. Fallback / Off-path 定义

| 场景 | 当前状态 | 需要补充 |
|-----|---------|---------|
| Primary 不可用 | ❌ 未定义 | fallback_order + max_retries=2 |
| 全部低置信度 | ❌ 未定义 | 直接 escalate 到 jury+Codex |
| Reviewer 超时 | ❌ 未定义 | timeout + partial_result_policy |
| 全部不可用 | ❌ 未定义 | fail_fast + error message |
| Config 损坏 | ❌ 未定义 | 使用 defaults 或 fail |

---

## 3. Disagreement 处理

### 当前覆盖
- ✅ PASS vs must fix
- ✅ by design vs bug
- ✅ incompatible fixes
- ✅ deterministic failure missed

### 缺失

| 场景 | 建议处理 |
|-----|---------|
| severity 差一级 (High/Medium) | 不算 disagreement，取高者 |
| severity 差两级+ | 算 disagreement，escalate |
| 同一问题修复建议不同 | 不算，交给 Codex 选择 |
| 2 vs 1 投票 | Codex tie-break |
| 全部 disagreement | Codex 自动介入 |

---

## 4. Low-confidence Escalation

### 缺失

```
confidence 来源：model 输出 confidence 字段 或从 score 推导
阈值：< 0.5 → escalate
阶梯：single → pair → jury → Codex
```

---

## 5. Must-Test-Before-Smoke (8 条)

| # | 测试 | 类型 |
|---|------|------|
| 1 | Primary 失败 → fallback | fallback |
| 2 | 单 reviewer 低置信度 → escalate | escalation |
| 3 | 两 reviewer 结论相反 → Codex 合成 | disagreement |
| 4 | Deterministic 失败但 review PASS → 最终 FAIL | boundary |
| 5 | Reviewer 超时 → partial result | timeout |
| 6 | Config 缺失字段 → 默认或错误 | validation |
| 7 | 全部通过 → PASS | happy path |
| 8 | jury 2 vs 1 → 裁定 | voting |

---

## 6. Nice-to-Have Tests

1. Cache 复用
2. 非标准格式响应 → 重试/降级
3. 高并发限流
4. Profile 动态更新后 routing 变化
5. 全部 reviewer 不可用 → 降级
6. Severity 跨 model 对齐
7. Review angle 分配

---

## 7. CR0 Readiness Checklist

- [ ] escalation_thresholds 量化定义
- [ ] fallback_order + timeout 定义
- [ ] skip_conditions 明确
- [ ] partial_result_policy 定义
- [ ] off-path handling 定义
- [ ] 8 条 must-test 用例通过
- [ ] deterministic > opinion 文档化
