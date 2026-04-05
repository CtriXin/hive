{"type":"tool_use","id":"tool_1W3suE6liOxyFBvlV13YcaFQ","name":"TodoWrite","input":{"todos":[{"content":"Implement lightweight HTTP router with middleware pipeline","status":"in_progress","activeForm":"Implementing lightweight HTTP router with middleware pipeline"},{"content":"Write tests for router (at least 5 cases)","status":"pending","activeForm":"Writing router tests"}]}}
{"type":"tool_use","id":"tool_oQ4gKRQGAn098i4WQxtCx5lk","name":"Write","input":{"file_path":"/Users/xin/auto-skills/CtriXin-repo/hive/router.ts","content":"export interface Context {\n  method: string;\n  path: string;\n  params: Record<string, string>;\n  query: Record<string, string>;\n  body: unknown;\n  headers: Record<string, string>;\n  status: number;\n  responseBody: unknown;\n  state: Record<string, unknown>;\n}\n\nexport type Middleware = (\n  ctx: Context,\n  next: () => Promise<void>\n) => Promise<void>;\n\ninterface Route {\n  method: string;\n  pathPattern: string;\n  handler: Middleware;\n}\n\ninterface MiddlewareEntry {\n  prefix: string | null;\n  middleware: Middleware;\n}\n\nexport class Router {\n  private routes: Route[] = [];\n  private middlewares: MiddlewareEntry[] = [];\n\n  get(pathPattern: string, handler: Middleware): void {\n    this.addRoute('GET', pathPattern, handler);\n  }\n\n  post(pathPattern: string, handler: Middleware): void {\n    this.addRoute('POST', pathPattern, handler);\n  }\n\n  delete(pathPattern: string, handler: Middleware): void {\n    this.addRoute('DELETE', pathPattern, handler);\n  }\n\n  private addRoute(\n    method: string,\...
{"type":"tool_use","id":"tool_TlqjQBBPw8ZhzsjjOP1k4u5b","name":"Read","input":{"file_path":"/Users/xin/auto-skills/CtriXin-repo/hive/router.ts"}}
{"type":"tool_use","id":"tool_plGaphgQvyl09O25rd9AYob5","name":"Read","input":{"file_path":"/Users/xin/auto-skills/CtriXin-repo/hive/router.test.ts"}}
{"type":"tool_use","id":"tool_lbiqqy3B1SVIdd8YUS2H6QXD","name":"Bash","input":{"command":"npx vitest run router.test.ts 2>&1","description":"Run router tests with vitest"}}
{"type":"tool_use","id":"tool_Fv6pnDMsQD9nuZfe4RMlCY00","name":"TodoWrite","input":{"todos":[{"content":"Implement lightweight HTTP router with middleware pipeline","status":"completed","activeForm":"Implementing lightweight HTTP router with middleware pipeline"},{"content":"Write tests for router (at least 5 cases)","status":"completed","activeForm":"Writing router tests"}]}}
任务完成。已实现的轻量级 HTTP 路由器和中间件系统位于：

- **实现**：`router.ts`
- **测试**：`router.test.ts`

支持的功能：
1. 路由注册：`get`、`post`、`delete`（以及已有的 `put`、`patch`）
2. 中间件系统：`router.use(middleware)` 全局中间件，`router.use('/prefix', middleware)` 路径前缀中间件
3. 洋葱模型：通过 `next()` 实现请求/响应阶段包裹
4. 错误处理：未匹配路由 404，异常 500 并返回错误信息
5. 查询参数、路由参数、中间件 `state` 共享

测试全部通过（27 个测试用例，覆盖了要求的 5 个场景及更多边界情况）。
