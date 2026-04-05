# SDK v3.0 中英术语对照表

本表用于确保变更通知、迁移指南及相关文档在中英文版本中的术语一致性。

| 英文术语 | 中文术语 | 说明 |
|---------|---------|------|
| Breaking change | 重大变更 / 破坏性变更 | 引入后不兼容旧版本的改动，需要开发者主动修改代码才能升级。 |
| API Key authentication | API Key 认证 | v2 中使用的静态密钥认证方式，通过 `X-API-Key` 请求头传递。 |
| OAuth 2.0 Bearer Token | OAuth 2.0 Bearer Token | v3 推荐的标准认证方式，通过 `Authorization: Bearer <token>` 请求头传递。 |
| Response format | 响应格式 | API 返回数据的整体结构。 |
| Success response | 成功响应 | 请求成功时返回的 JSON 结构。 |
| Error response | 错误响应 | 请求失败时返回的 JSON 结构。 |
| Structured error | 结构化错误 | 错误信息以对象形式呈现，包含 `code`、`message`、`details` 等字段。 |
| Request ID | 请求 ID | 用于唯一标识一次 API 请求，便于日志追踪与排障。 |
| Timestamp | 时间戳 | 服务器返回响应时的 Unix 时间戳（单位：毫秒或秒）。 |
| Offset-based pagination | 偏移分页 | v2 的分页方式，通过 `page` 和 `size`（或 `limit`）定位数据页。 |
| Cursor-based pagination | 游标分页 | v3 的分页方式，通过不透明的 `cursor` 定位下一页数据。 |
| Cursor | 游标 | 一个 opaque 字符串，用于在游标分页中获取下一页数据。 |
| Next cursor | 下一页游标 | 响应中提供的获取下一页数据所需的游标值，为 `null` 时表示没有更多数据。 |
| Has more | 是否还有更多数据 | 布尔值，指示是否还存在后续数据页。 |
| Migration guide | 迁移指南 | 帮助开发者从旧版本升级到新版本的文档。 |
| Deprecation window / Sunset period | 迁移期 / 弃用缓冲期 | 旧功能仍可使用的过渡时间段，结束后将彻底下线。 |
| Authorization header | 授权请求头 | HTTP 请求中用于携带身份凭证的请求头字段。 |
| Meta | 元数据 | 成功响应中附带的额外信息（如 `requestId`、`timestamp`）。 |
| Error code | 错误码 | 结构化错误中的机器可读标识符，如 `INVALID_CURSOR`。 |
| Error message | 错误信息 | 面向开发者的可读错误描述文本。 |
| Error details | 错误详情 | 结构化错误中的可选字段，携带与错误相关的上下文数据。 |
| Query parameter | 查询参数 | URL 中跟在 `?` 后的键值对参数。 |
| Limit | 单次返回数量上限 | 游标分页中用于控制每页返回条目数的参数。 |
| End-to-end example | 端到端示例 | 从请求发起、响应处理到异常捕获的完整代码示例。 |
