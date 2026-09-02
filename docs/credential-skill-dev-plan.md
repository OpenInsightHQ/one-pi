# 跨端技能凭证体系与免安装技能加载 — 开发文档

涉及仓库：

| 系统 | 角色 | 地址 | 技术栈 |
|---|---|---|---|
| dmp | 管理端 | `C:\workspace\OpenInsightHQ\dmp-github` | Java (yudao/Spring Boot) + Vue3 (client/) |
| pi | Agent 运行时 | `C:\workspace\OpenInsightHQ\pi-agent-github` | Node/TS (packages/coding-agent) |
| arp | 用户端 | `C:\workspace\OpenInsightHQ\arp-github` | LibreChat fork (api/ + client/) |

三端共享同一 MongoDB（库名 `LibreChat`）。

---

## 1. 目标

1. 技能凭证全生命周期：管理员统一配置 / 用户自绑两种归属，加密存 MongoDB，永不回显明文
2. http / mcp 技能**免安装到 pi 环境**：pi 会话创建时直接读 `skills` / `mcpservers` 表
3. pi 端两级技能发现（O(N) 目录注入 + 按需 describe）+ 统一执行工具（凭证服务端注入，模型可执行面无凭证）
4. arp 用户侧自服务：我的凭证、我的 skill（查看/绑定凭证/上传/创建 http+mcp 并测试连接）

## 2. 总体数据流

```
dmp(管理员) ──写──> skills / mcpservers (定义 + requiresCredentials 声明)
dmp(管理员) ──写──> credentials (管理员凭证, 加密)
arp(用户)   ──写──> credentials (用户凭证, 加密)
arp(用户)   ──写──> skills / mcpservers (用户自建 http/mcp)

pi 会话创建:
  读 skills/mcpservers (ACL 过滤) → 组 <available_http_skills>/<available_mcp_skills>/<available_skills> 注入 system prompt
模型调用:
  skill_describe(skill) → 接口清单+schema
  skill_execute(kind, skill, api, params)
    → 凭证解析(解密+缓存) → [http: token管理+fetch | mcp: 惰性握手+headers | script: 服务端spawn]
    → 结果(精确值擦洗后)返回模型
```

---

## 3. 数据模型设计（三端契约，先行对齐）

### 3.1 `skills` 表新增字段（`Skill.java` 已有 skillType: http/mcp/repo）

```json5
{
  requiresCredentials: true,            // 是否需要凭证
  userManaged: true,                    // 凭证是否由用户自设（false=仅管理员统一配置）
  credentialSchema: [                   // 凭证字段声明（值存 credentials，此处只存定义）
    { "secretKey": "app_id",     "displayName": "App ID",    "sensitive": false },
    { "secretKey": "app_secret", "displayName": "App Secret", "sensitive": true }
  ],
  apiDefinitions: [ ... ]               // http 技能：HttpApiDefinition[]（原 apis.json 内容入库，pi 直读）
}
```

### 3.2 `mcpservers` 表新增字段（`McpServer.java`）

```json5
{
  requiresCredentials: true,
  userManaged: true,
  credentialSchema: [ ... ],            // 同上
  // 映射规则：凭证如何进入 MCP 连接
  credentialBinding: {
    headerMap: { "app_id": "X-App-Id", "app_secret": "X-App-Secret" },  // secretKey → 请求头
    authType: "headers" | "bearer"      // bearer: 取第一个 sensitive 字段做 Authorization: Bearer
  }
}
```

### 3.3 新集合 `credentials`

```json5
{
  userId: ObjectId,                     // 归属用户；管理员统一凭证用固定 0 值/常量 ADMIN_PRINCIPAL
  resourceType: "skill" | "mcp",
  resourceName: "feishu",               // skill.name 或 mcpservers.serverName
  cipher: "aes-256-gcm",
  iv: "<b64>", authTag: "<b64>",
  data: "<b64>",                        // 加密后的 JSON { secretKey: value }
  keyVersion: 1,
  lastVerifiedAt: Date,
  status: "active" | "invalid"
}
// 唯一索引 (userId, resourceType, resourceName)
```

**加密互操作规范（Java/Node 三端一致）**：
- 算法 AES-256-GCM；主密钥 32 字节 base64，环境变量 `PI_CREDENTIAL_MASTER_KEY`（dmp 配置同名项）
- 明文 = `credentialSchema` 中 secretKey → 值 的 JSON 对象；加密后仅存 iv/authTag/data
- `keyVersion` 支持主密钥轮换（换钥时后台任务重加密）
- 任何查询接口只返回 `{configured, lastVerifiedAt, status}`，**永不返回 data/iv/authTag**

### 3.4 凭证解析规则（pi 执行时）

```
1. requiresCredentials=false            → 无凭证直接执行
2. userManaged=true  → 先查用户凭证 → 无则回退管理员凭证 → 都无则"凭证未绑定"引导
3. userManaged=false → 仅管理员凭证 → 无则报错"请联系管理员配置"
```

---

## 4. dmp 开发内容

### 4.1 后端

| 项 | 说明 | 位置 |
|---|---|---|
| SkillCredential 文档/仓库 | `@Document("credentials")` + Spring Data Repository | `dmp-closed-source/agent-platform-module`（与 Skill/McpServer 同层） |
| 凭证 Service/Controller | 管理员凭证 CRUD（加解密按 3.3 规范）、验证（按平台调一次测试接口写 lastVerifiedAt） | `yudao-module-store-biz` 新增 `controller/admin/skillcredential/` |
| 字段扩展 | `Skill.java`、`McpServer.java` 增加 3.1/3.2 字段 | `agent-platform-api/model/` |
| http 技能入库 | HttpSkill 保存时把 apiDefinitions 写入 skills 文档（pi 直读的前提） | `HttpSkillServiceImpl` / `SkillRegistryServiceImpl` |
| 列表接口 | 技能列表/详情返回 `requiresCredentials`、`userManaged`、`credentialConfigured`（管理员维度状态），不回显值 | `SkillController` / `HttpSkillController` / `McpSkillController` |

接口（示例）：

```
POST   /store/skill-credential            绑定/更新管理员凭证 {resourceType, resourceName, values}
GET    /store/skill-credential/list       按技能查询配置状态（脱敏）
DELETE /store/skill-credential            解绑
POST   /store/skill-credential/verify     验证凭证 {resourceType, resourceName}
```

### 4.2 前端（client/src/views/store/）

| 页面 | 内容 |
|---|---|
| 凭证管理（新） | 技能管理下新增子菜单：列出所有 requiresCredentials 技能 → 绑定/更新/删除管理员凭证表单（按 credentialSchema 动态渲染，sensitive 字段密码框）、验证按钮、状态列 |
| skill 技能表单（改） | `views/store/skill/`：新增"需要凭证"开关 + credentialSchema 编辑器 + "用户自设"开关 |
| httpSkill 表单（改） | `views/store/httpSkill/HttpSkillForm.vue`：同上字段；保存走 apiDefinitions 入库 |
| mcpSkill 表单（改） | `views/store/mcpSkill/McpSkillForm.vue`：同上 + credentialBinding 头映射配置 |

---

## 5. pi 开发内容（packages/coding-agent）

### 5.1 Mongo 层（按 AGENTS.md "新增集合"流程）

`src/core/mongo/`：`types.ts` 加 `SkillCredentialDoc` → `schemas.ts` 加 schema → `models.ts` 加 `getSkillCredentialModel()` → 新建 `credential-service.ts`：

```ts
getCredentials(userId, resourceType, resourceName)  // 解密 + 进程内 TTL 缓存(5min, set 时失效)
setCredentials(...) / hasCredentials(...)            // 门控用，不解密
```

### 5.2 技能加载改造：直读 MongoDB（去安装）

- `createHttpResourceLoader`（http-api-shared.ts）扩展：除现有 savePath/ACL 目录外，新增查询 `skills` 表 `skillType in (http, mcp)` 且 ACL 通过的记录；http 用 `apiDefinitions`，不再要求 symlink 安装
- mcp：读 `mcpservers` 表（`author=userId` 或 ACL 授权），构建 per-user 注册表；`McpRegistryEntry` 缓存 manifest 供 describe 零连接使用
- ACL：`aclentries` 现有 `resourceType=skill`；mcp 授权新增 `resourceType: "mcp"`（复用 resolveUserPrincipals）
- `/skills/authorize` symlink 流程对 http/mcp 类型标记废弃（repo 型 SKILL.md 仍走 savePath）

### 5.3 system prompt 注入（O(N) 目录）

```
<available_http_skills>
  feishu: 飞书消息与文档操作 | 8 接口 | 凭证:已配置
  dingtalk: 钉钉审批通知 | 6 接口 | 凭证:未配置(用户自设)
</available_http_skills>
<available_mcp_skills>
  modelscope-server: 模型服务调用 | 11 工具 | 凭证:管理员已配置
</available_mcp_skills>
<available_skills> ...（SKILL.md 型，现状保留）</available_skills>
```

- 凭证状态由 `hasCredentials()`（按 3.4 解析规则）得出，未配置的标注提示（不隐藏，供模型引导用户）
- 条目 = name + description + 接口数 + 凭证状态，O(N) 常驻

### 5.4 agent tools（仅 2 个）

```ts
skill_describe { skill }        // http: apiDefinitions / mcp: registry manifest / script: tool.json
                                // 只返回 exposeToModel != false 的接口
skill_execute { kind: "http"|"mcp"|"script", skill, api, params }
```

执行链（统一咽喉点）：

- **http**：解析 requiresSecrets → getCredentials → TokenManager（tenant_access_token 等，按 userId:skill 缓存，提前 5min 刷新）→ 拼头 → `executeHttpSkill`；params 先按 apiDefinitions schema 校验，失败返回期望 schema 供模型自纠
- **mcp**：凭证按 credentialBinding 拼进 headers → 惰性 `mcpInitializeSession`（首次调用才握手），`Mcp-Session-Id` 按 `userId:serverName` 缓存 + 空闲 TTL 驱逐 → `callMCPTool`
- **script**：服务端 `spawn("python", ["main.py", ...])` 直启（不经 bash 工具、不走 shell），凭证只进该子进程 env；stdout/stderr **精确值擦洗**（服务端已知注入的确切值替换为 `***`）后返回

### 5.5 凭证缺失引导

`skill_execute` 检测凭证未绑定时返回结构化错误：

```
技能 feishu 需要凭证且未绑定（需: App ID, App Secret, 用户自设）。
请引导用户到 arp「我的凭证」完成配置后重试。
不要在对话中索要或接收凭证明文。
```

模型据此提示用户 out-of-band 配置。若产品坚持对话内输入，仅作为显式开关的降级路径（stdin 传值 + 持久化层脱敏 + 提示轮换），默认关闭。

### 5.6 个人技能同步入库（skill-creator 产物）

skill-creator 是 repo 型技能（`/app/skill-repo/general/skill-creator/`），模型经 bash 写文件到个人技能目录，无代码钩子、不入 Mongo。采用"惰性同步为主 + 创建后登记为辅"：

- `syncPersonalSkills(userId)`：扫描 `sessions/<userId>/skills/` 各 SKILL.md frontmatter → upsert skills 集合（`skillType: "repo"`, `author: userId`, `savePath: <dir>`, `source: "skill-creator"`），幂等键 `(name, author)`；目录消失置 `status: disabled`（软删除）。触发点（三处）：
  1. 会话创建装配目录前
  2. `POST /skills/sync` 手动端点（带 X-User-Id，进程内按用户记上次同步时间，60s 内重复请求直接跳过）
  3. arp「我的skill」页面打开时：arp 先调 `POST /skills/sync`，完成后再查 Mongo 渲染；pi 不可达时降级用旧数据渲染，不阻塞页面
- skill-creator SKILL.md 指令追加：创建完调 `POST /skills/register-personal` 登记（best-effort，同步兜底）
- 生成模板支持 `requiresSecrets` frontmatter，同步时解析入 `credentialSchema` → 用户自建 skill 可绑凭证、可 ACL 分享、arp「我的skill-我创建的」可见

### 5.7 外层 agent 目录同源（arp execute_skill 路径）

arp 外层 agent 的 `execute_skill {skillName, input}` 转发到 pi `POST /execute-agent-skill`（skillExecution 子代理模式）。原则：**目录同源、执行同径，arp 工具零改动**：

- pi 暴露 `GET /skills/catalog?userId&agentId`：返回渲染好的三段 XML（`<available_skills>`/`<available_http_skills>`/`<available_mcp_skills>`），arp initializeAgent 调用拼接外层 prompt——目录拼装只在 pi 一处实现
- `/execute-agent-skill` 内部扩展路由：skillName 命中 http/mcp 型技能时直接走统一 `skill_execute` 执行链（凭证注入/token/擦洗），repo 型维持 `/skill:<name>` 子代理模式
- 凭证缺失引导在两条入口统一；`/v1/chat/completions`（arp chatCompletions.js）同样复用 catalog 生成，保证三个入口（pi /prompt、arp v2、arp openai 兼容层）目录一致

### 5.8 其他

- skillPathGuard 扩展：`~/.pi/agent/sessions/<userId>/credentials/` 纳入 deny（若保留本地凭证文件兼容）
- `mcp_${toolName}` 命名冲突隐患与本改造无关（不再全量注册），registry 保留但 agent tool 出口只有 skill_execute

---

## 6. arp 开发内容

### 6.1 我的凭证（左下角菜单）

- client：`client/src/components/SidePanel/` 下新增入口（现有 MCPBuilder 同级），路由/菜单注册到左下角
- api：新增 `api/server/routes/credential.js` + data-schemas 模型（读写 `credentials`，Node 端加密与 3.3 规范一致）：

```
GET    /api/credentials            我绑定的凭证列表（resourceType+name+status+lastVerifiedAt，脱敏）
PUT    /api/credentials/:type/:name   绑定/更新（body: {values}，按 skill.credentialSchema 校验）
DELETE /api/credentials/:type/:name   解绑
POST   /api/credentials/:type/:name/verify   验证（转发 pi 或直接实现）
```

- 列表数据源：查询 `skills`/`mcpservers` 中 `userManaged=true` 且我有权使用的技能 + `credentials` 中 userId=我的绑定状态

### 6.2 我的 skill

新页面（SidePanel 面板或独立路由）：

| 功能 | 实现要点 |
|---|---|
| 列表 | 页面打开先调 pi `POST /skills/sync`（TTL 节流，pi 不可达降级旧数据），再查询：类型 Tab：http / mcp / skill；来源筛选：授权给我的（ACL 通过，读 aclentries）+ 我创建的（skills.author=我 / mcpservers.author=我，含同步入库的 skill-creator 产物） |
| 绑定凭证 | 列表行操作：仅 `userManaged=true` 且 requiresCredentials 的显示；表单按 credentialSchema 动态渲染 → 调 6.1 凭证 API |
| 上传 skill | zip 上传代理到 pi 现有 `POST /skills/upload`（arp 只做 UI + 转发），写 skills 表 author=我 |
| 创建 http 技能 | 表单参考 dmp `views/store/httpSkill/HttpSkillForm.vue` 的字段结构（apiDefinitions：method/url/params/body）；写入 skills 表（skillType=http, author=我），私有不走 ACL |
| 创建 mcp 技能 | 复用 arp 现有 MCPBuilder 能力（`client/src/components/SidePanel/MCPBuilder/MCPServerDialog/` + `api/server/routes/mcp.js`），写 mcpservers 表；增加 requiresCredentials/credentialSchema/credentialBinding 字段编辑 |
| 测试连接 | http：arp 后端直接 fetch 目标 URL（可携带已绑定凭证）；mcp：复用现有 MCP 握手/status 逻辑（`services/Tools/mcp.js`、`/connection/status`） |

用户自建技能默认个人可见；分享/授权沿用现有 ACL 授权流（dmp 或 arp 管理入口）。

---

## 7. 接口契约汇总

| 端 | 契约 | 消费方 |
|---|---|---|
| 共享 | 3.1/3.2 字段、3.3 加密规范、3.4 解析规则 | 三端全部 |
| pi | `POST /skills/upload`（已有）、可选 `/skills/test-connection` | arp 上传/测试 |
| pi | `POST /skills/sync`、`POST /skills/register-personal`（个人技能入库） | skill-creator 产物登记、arp 我的skill |
| pi | `GET /skills/catalog?userId&agentId`（渲染好的 XML 目录） | arp initializeAgent 外层 prompt |
| pi | `POST /execute-agent-skill`（已有，扩展 http/mcp 路由）、skill_execute / skill_describe（agent tool） | arp execute_skill 转发、模型 |
| arp | `/api/credentials/*`、`/api/mcp/*`（已有扩展）、我的 skill CRUD | arp client |
| dmp | `/store/skill-credential/*`、技能表单字段扩展 | dmp client |

## 8. 开发顺序与里程碑

1. **M1 契约冻结**：3.x 数据模型 + 加密互操作规范（三端评审，先合入字段定义，向后兼容）
2. **M2 dmp**：credentials 后端 + 技能字段扩展 + 前端凭证管理（可用常量 key 先行）
3. **M3 pi**：credential-service → 直读加载 → prompt 注入 → skill_describe/skill_execute 执行链 → 凭证缺失引导
4. **M4 arp**：我的凭证 → 我的 skill（列表/绑定/上传/创建/测试连接）
5. **M5 联调 E2E**：管理员配凭证→用户调 skill；用户自绑→调用；未绑定→引导→绑定→重试 三条主链路

依赖关系：M3 依赖 M1（字段）；M2/M4 可并行；M5 全部就绪后。

## 9. 安全要点 Checklist

- [ ] credentials 任何读接口不回显 data/iv/authTag，GET 只返回状态
- [ ] 凭证解密仅发生在 pi 执行器 / arp、dmp 写入前的加密点；明文进程内 TTL 缓存，set 即失效
- [ ] 模型可执行面无凭证：skill_execute 的 params 为受 schema 校验的数据；script 型服务端 spawn、不走 shell、不经 bash 工具
- [ ] script stdout/stderr 精确值擦洗后再返回模型
- [ ] mcp 连接与 token 缓存均按 userId 隔离
- [ ] 凭证缺失引导文案明确禁止在对话中收发明文
- [ ] credentialSchema 的 sensitive 字段在所有前端渲染为密码框
- [ ] 主密钥仅存环境变量/配置中心，不入库不入 git；keyVersion 轮换预案
- [ ] 用户自建 skill 上传走审核/病毒扫描（沿用 pi skills verify 机制）后才可配凭证
