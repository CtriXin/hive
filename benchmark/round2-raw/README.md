# Round 2 Raw Responses — Timing & Metadata

> Dispatched: 2026-03-27 (re-dispatch after context compaction)

| Model | Task ID | Duration (ms) | Duration (s) | Input Tokens | Output Tokens | Status |
|-------|---------|---------------|-------------|--------------|---------------|--------|
| qwen3-coder-plus | r2-qwen3coderplus | 41,508 | 42 | 985 | 2,560 | success |
| MiniMax-M2.5 | r2-minimax25 | 60,286 | 60 | 878 | 3,618 | success |
| glm-5-turbo | r2-glm5turbo | 62,288 | 62 | 900 | 3,765 | success |
| qwen3-max | r2-qwen3max | 121,230 | 121 | 985 | 3,431 | success |
| kimi-k2.5 | r2-kimik25 | 129,328 | 129 | 0 | 6,452 | success |
| glm-4.7 | r2-glm47 | 133,140 | 133 | 900 | 4,117 | success |
| kimi-for-coding | r2-kimiforcoding | 133,805 | 134 | 899 | 7,231 | success |
| qwen3.5-plus | r2-qwen35plus | 141,094 | 141 | 951 | 7,081 | success |
| glm-5 | r2-glm5 | 195,601 | 196 | 902 | 8,192 | success (truncated) |
| MiniMax-M2.7 | r2-minimax27 | 200,739 | 201 | 882 | 8,192 | success (truncated) |

**Notes:**
- glm-5 and MiniMax-M2.7 hit the 8192 output token limit (responses truncated)
- Fastest: qwen3-coder-plus (42s), Slowest: MiniMax-M2.7 (201s)
- Time scoring formula: `time_score = 10 × (42 / model_time)`
