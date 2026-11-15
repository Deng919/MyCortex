# MyCortex 知识库：聊天与独立连接

知识库通过现有 OpenClaw 聊天模型的 `knowledge_read` / `knowledge_write` 工具使用，支持保存原文/引用、按任务检索、材料列表、带依据读取、纠正和删除。独立 AI 可通过 MCP stdio 连接同一个存储。Windows 用户可使用[记忆客户端](desktop.md)查看、编辑和删除记忆；离线 CLI 继续用于直接管理和备份。

代码位于 OpenClaw 核心 `src/knowledge`，知识数据独立于聊天和 Agent。当前用合成资料验证，生产加密方式尚待确定。

## 聊天入口

在现有 OpenClaw 配置中加入 `tools.knowledge`，使用绝对目录，并给实际会话键授予能力。下面是配置片段，模型接入和 Gateway 配置沿用现有设置：

```json5 validate=false
{
  agents: {
    defaults: {
      compaction: { memoryFlush: { enabled: false } },
      models: {
        "ollama/qwen3.5:9b-q4_K_M": { params: { temperature: 0, num_ctx: 32768 } },
      },
    },
  },
  plugins: { slots: { memory: "none" } },
  tools: {
    allow: ["knowledge_read", "knowledge_write"],
    toolSearch: false,
    knowledge: {
      directory: "D:/Cache/MyCortex/chat-demo/knowledge",
      connections: {
        "agent:main:main": ["read", "submit", "manage", "organize"],
        "agent:main:another-chat": ["read"],
      },
      fileRoots: ["D:/Cache/MyCortex/chat-demo/files"],
      // Optional: only this explicitly configured model may receive material for organization.
      processing: {
        provider: "ollama",
        model: "qwen3.5:9b-q4_K_M",
        maxOutputTokens: 1200,
        timeoutMs: 60000,
      },
    },
  },
}
```

示例将工具限制为知识读写，并关闭旧 memory 插件和压缩前写记忆，便于在独立合成实例检查知识闭环。使用本机 9B 时，提供方模型的 `contextWindow` 与实际 Ollama `params.num_ctx` 都设为 32,768；只改前者不会扩大 Ollama 的实际窗口。其他对话模型沿用自己的配置。

通过现有入口 `pnpm openclaw gateway run` 启动后，在获准会话中直接说：

- “记住这段原文：我打算周日复习卷积，还没决定是否参加活动。”
- “我周末打算学什么？请给出保存的依据。”
- “列出最近保存的材料。”
- “纠正刚才那条：改成周六复习拉普拉斯变换。”
- “删除刚才那条材料。”

会话键需使用实际会话的完整键；新会话不会自动继承旧会话的知识权限。缺省不提供知识工具；`read` 允许检索/读取，`submit` 允许新增，`manage` 允许明确维护，`organize` 允许程序读取材料并送入已配置的整理模型。连接身份由运行时提供，模型不能通过参数切换身份或目录。运行时配置下撤销授权或改变目录会使已创建工具拒绝执行；显式固定配置的调用沿用该调用配置。

模型直接选择知识工具，不增加一个路由模型。检索支持最多 6 个短关键词的大小写不敏感 OR 匹配，也匹配当前整理主题；首次结果含有界原文/解释预览，正文可按 ID 分段读取。结果携带材料 ID、源修订、来源和时间。未命中只说明本次搜索未找到材料。链接引用没有已保存正文。

## 自动整理与上下文

保存成功后材料可立即检索。若同时配置 `processing` 并授予连接 `organize`，程序会用该模型做一次无工具的有界整理，验证结果后保存派生解释；错误、空结果或超长输入均保留原文和真实处理状态。2026-11-15在真实Gateway中验证：保存自动整理返回 organized，写入两个逐字引文；纠正后再次整理可返回 empty，原文仍保留。两次整理调用usage分别为734和601 tokens。处理服务默认不启用，没有后台扫描或按轮次自动保存聊天。

待办与材料修订一起持久保存；中断后可通过同一知识工具的 `organize_pending` 每次继续一份。原文纠正会按新修订重新整理。当前输入正文上限为 8,000 字符，超出时整份保留原文并记录跳过，不截取一部分后当成完整解释。用户明确纠正解释时检查原文和解释两个版本，自动整理不能覆盖人工修正。

解释记录主题、主体、意向/不确定/他人观点等立场及逐字引文，属于模型解读。程序能检查来源修订、逐字引文和原话时间；引用是否支持解释还依赖模型质量。本机 9B 曾产生遗漏和语义错误，实际处理状态与原文应一同查看。

`context` 按当前任务取相关材料及解释预览，回答仍由同一对话模型生成。每次涉及已保存知识的问答要求重新查询当前库；旧对话已读出的内容仍存在于会话历史，当前没有从所有历史副本中自动抹除已披露内容。

聊天模型按既有模型连接计费；整理至多增加一次显式配置的模型调用，返回该次 `usage`，不可得时为未知。字面存取不调用模型。搜索预览有 6,000 字符预算，正文默认读取 3,000、最多 8,000 字符；这些是结果大小限制，不是整个模型请求的 token/费用上限。

## 文件原位保留

让模型保存 `kind=reference`、空正文、`file:///D:/...` 来源的文件引用即可索引位置，不复制正文。搜索可按标题/路径定位，再用 `read_file` 在 `fileRoots` 授权范围内读取当前 UTF-8 文本。文件变更返回新的字节哈希，文件消失则报缺失；不会用旧正文冒充当前文件。拒绝越界、符号链接、硬链接、无效 UTF-8 和超过 256 KiB 的文件。

索引引用不含历史字节；历史内容需要此前明确保存的正文或快照。PDF/Word 解析和目录批量接入仍待实现。

## 外部 AI 通过 MCP 连接

MCP 客户端直接启动源码入口，stdout 只承载协议：

```json validate=false
{
  "mcpServers": {
    "mycortex": {
      "command": "node",
      "args": [
        "--import",
        "file:///D:/Desktop/MyCortex/core/scripts/tsx.mjs",
        "D:/Desktop/MyCortex/core/scripts/mycortex-knowledge.mts",
        "knowledge",
        "--store",
        "D:/Cache/MyCortex/chat-demo/knowledge",
        "serve",
        "--connection",
        "external-demo",
        "--capabilities",
        "read,submit,manage",
        "--file-root",
        "D:/Cache/MyCortex/chat-demo/files"
      ]
    }
  }
}
```

这是本地 stdio 连接：权限由启动它的操作者明确给出，默认仅 `read`，关闭进程即撤销连接。没有新建匿名网络监听。外部 AI 读取/回传直接使用同一知识工具，无需把回答再交给第二聊天模型。这个启动方式不继承 Gateway 的整理模型配置；文件读取范围通过可选的 `--file-root <directories...>` 显式给出，不提供时不能读取原位文件。Windows 的 `--import` 绝对路径须使用 `file:///` URL。

### 对话默认读取与保存

MCP 在初始化时发送使用规则，并在对应工具说明中保留规则，按连接能力启用：

- `read`：回答涉及用户偏好、背景、过去决定或计划时，主动用少量关键词查询当前库，根据相关材料自然回答；普通通用问题跳过查询。预览够用时不再读全文；当前明确要求优先于旧偏好。未命中或失败时继续依据当前对话回答，不编造个人资料。
- `submit`：正常聊天出现值得长期复用的新信息时，主动归纳，在话题自然节点合并提交，不等用户逐次说“记住”。正文区分 Agent 摘要与选定原话，保留归属、时间、不确定与否定。跳过假设、举例、秘密、用户要求不保存的内容及已查出的旧材料；不为每轮新增判断模型或查重查询。
- 只读连接不会收到自动保存规则；仅提交连接不要求读库。纠正和删除继续需要用户明确指令及对应权限。保存成功以工具回执为准。

这些是交给客户端 Agent 的默认行为说明。实际主动调用取决于客户端是否把说明和工具提供给模型并采用它们；MCP 服务无法访问未发送给它的对话，也不会在后台抓取完整聊天。客户端需重新连接以取得新说明。

Codex 需在现有 `mcp_servers.mycortex` 段落内加入 `required = true`，让首次回答等待 MCP 就绪。实测中，未等待就绪的普通对话没有主动调用；启用后正常聊天触发了保存，无需每次粘贴规则。该设置也意味着服务启动失败会阻止会话正常开始，应先确认启动命令可用。

获准自动读写的 Codex 连接还需一次性配置对应工具的审批模式，否则非交互运行可能返回 `MCP tool call requires approval, but approval policy is never`：

```toml
[mcp_servers.mycortex.tools.knowledge_read]
approval_mode = "approve"

[mcp_servers.mycortex.tools.knowledge_write]
approval_mode = "approve"
```

这些客户端设置只改变启动等待与逐次审批，实际读写能力仍由服务端连接授权控制。无需额外全局提示词；规则由 MCP 提供。配置字段见 [Codex 官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 启动

需要 Node.js 24.16+（符合根 package.json 的版本范围）及已安装的项目依赖。当前开发机已安装依赖，缓存位于 `D:\Cache\MyCortex`。

在 PowerShell 中运行：

```powershell
cd D:\Desktop\MyCortex\core
& .\scripts\knowledge.ps1 --help
& .\scripts\knowledge.ps1 --store D:\Cache\MyCortex\demo init
```

每次显式指定 `--store`，数据文件是该目录下的 `knowledge.sqlite`。工具不会使用默认 OpenClaw 状态目录。新库为数据库 v2，已有 MyCortex v1 库自动升级；其他格式或不支持版本拒绝打开。

## 保存和查询

先创建一份合成测试文本：

```powershell
Set-Content -Encoding utf8 D:\Cache\MyCortex\demo-note.txt '合成材料：测试项目计划周一完成。'
& .\scripts\knowledge.ps1 --store D:\Cache\MyCortex\demo add `
  --file D:\Cache\MyCortex\demo-note.txt `
  --title '合成项目计划' --source 'synthetic:project-note' `
  --author 'synthetic-user' --request 'demo-note-1'

& .\scripts\knowledge.ps1 --store D:\Cache\MyCortex\demo search '周一'
& .\scripts\knowledge.ps1 --store D:\Cache\MyCortex\demo list
& .\scripts\knowledge.ps1 --store D:\Cache\MyCortex\demo read '<返回的 id>'
```

`--source` 是来源地址或可识别来源描述，不会自动抓取。`--author` 表示原作者，未知时可填 `unknown`；`--submitted-by` 表示转交者，默认 `local-operator`，它是来源记录，不是认证身份。`--observed-at` 可提供已知的来源时间，格式为含时区的 ISO 日期；不知道时留空，不猜测。

同一 `--request` 与相同内容重复提交会返回当前材料；同编号换内容会报错。正文最多 256 KiB。当前是字面子串查询，支持中文、标点和百分号，最多返回 50 条，每条正文摘录最多 240 字符；结果是原始材料，不是 AI 验证后的事实。

仅保存链接：

```powershell
& .\scripts\knowledge.ps1 --store D:\Cache\MyCortex\demo reference `
  --title '合成参考链接' --source 'https://example.invalid/note' `
  --author unknown --request demo-link-1
```

链接保存成功只表示 URI 已保存，网页正文没有抓取或备份。

## QQ Digest 导入

QQ Digest 保留完整 QQ 归档，只有已经确认并实际写入 QQ Digest 知识库的候选才导出。先在 QQ Digest 项目执行：

```powershell
D:\CodexTools\python\Scripts\qq-digest.exe export-mycortex `
  --config-path D:\Desktop\AI\chatbot\config\config.yaml `
  --out D:\Cache\MyCortex\qqdigest-2026-11-15.json
```

然后导入同一 MyCortex store：

```powershell
& .\scripts\knowledge.ps1 --store D:\Cache\MyCortex\demo init
& .\scripts\knowledge.ps1 --store D:\Cache\MyCortex\demo import-qqdigest `
  --file D:\Cache\MyCortex\qqdigest-2026-11-15.json
```

导入材料正文中保留候选正文、筛选理由和有限原消息上下文，来源为 `qqdigest://...` URI。每个候选使用 `qqdigest:candidate:<id>` 作为稳定请求编号：重复导入不重复建条目，正文变化会记录为新的 MyCortex 修订。bundle 和目标数据库必须由操作者显式指定；该命令不读取 QQ 数据库，也不接收 pending、later 或 ignored 候选。

## 纠正、历史和删除

```powershell
Set-Content -Encoding utf8 D:\Cache\MyCortex\demo-note.txt '合成纠正：测试项目改为周三完成。'
& .\scripts\knowledge.ps1 --store D:\Cache\MyCortex\demo correct '<id>' `
  --revision 1 --file D:\Cache\MyCortex\demo-note.txt --note '用户明确纠正'
& .\scripts\knowledge.ps1 --store D:\Cache\MyCortex\demo history '<id>'
& .\scripts\knowledge.ps1 --store D:\Cache\MyCortex\demo read '<id>' --revision 1
& .\scripts\knowledge.ps1 --store D:\Cache\MyCortex\demo delete '<id>' --revision 2
```

纠正增加修订，保留原始来源、原作者和旧版；搜索与默认读取只使用当前版本。`history` 返回最近 50 个修订的时间、转交者与原因；可按已知修订号读取更早版本。纠正和删除需要当前修订号，过期操作会返回冲突。链接条目没有正文；要保留其内容，应新增一份有来源的文本材料。

删除清除本库全部修订的正文、标题、来源和身份字段，并保留 id、请求编号、指纹、修订号和删除时间用于阻止旧提交复活。源文件不会被删除。SQLite 开启 secure_delete，使用 DELETE journal；设备备份、用户导出、操作系统副本和此前已经读出的内容由各自持有者管理。

## 导出和恢复

```powershell
& .\scripts\knowledge.ps1 --store D:\Cache\MyCortex\demo export `
  --out D:\Cache\MyCortex\demo-backup.json
& .\scripts\knowledge.ps1 --store D:\Cache\MyCortex\demo export-deletions `
  --out D:\Cache\MyCortex\latest-deletions.json
& .\scripts\knowledge.ps1 --store D:\Cache\MyCortex\restored-demo init
& .\scripts\knowledge.ps1 --store D:\Cache\MyCortex\restored-demo import `
  --file D:\Cache\MyCortex\demo-backup.json `
  --deletions-from D:\Cache\MyCortex\latest-deletions.json
```

导出是含历史和删除标记的明文 JSON，最多 32 MiB、10,000 个材料、100,000 个修订。目标文件必须不存在。导入校验格式、来源正文约束、完整修订序列和原始提交指纹，原子写入空库；拒绝覆盖已有材料的库。

恢复前合并最新删除账本，剔除旧备份中后来删除的所有修订/解释，并保留删除标记。账本必须从仍持有最新状态的权威库导出；程序无法验证某个外部文件是否为用户最后保留的账本。需要故意查看旧历史状态时才使用 `--historical`。恢复不包含连接授权，授权继续来自当前主机配置。超过导出上限时，停止全部知识库操作后可备份整个 SQLite 文件；直接复制旧数据库不是带删除账本的恢复流程。

## 当前范围

- 运行期 SQL 在已有 WorkerTaskPool 中执行，复用与离线 CLI 相同的进程锁和权威存储；空库列表/查询返回空，无需聊天用户手动初始化。
- 同一目录的命令通过进程锁串行执行，写入在事务提交前再检查当前授权。已获准提交后丢失回执时会报告结果未知，要求核对当前修订。
- QQ/微信自动采集、目录批量扫描、PDF/Word 解析、E2EE 与生产部署仍待实现。独立 Windows 记忆窗口已有源码启动器，独立分发安装包尚未提供。
- 数据模型保持来源开放，不设置学历、健康等固定领域。

## 验证

```powershell
node scripts/run-vitest.mjs src/knowledge/store.test.ts src/knowledge/organization-store.test.ts src/knowledge/organizer.test.ts src/knowledge/recovery.test.ts src/knowledge/files.test.ts src/knowledge/client.test.ts src/cli/knowledge-cli.test.ts src/mcp/knowledge-serve.test.ts src/agents/tools/knowledge-tools.test.ts --maxWorkers=1

# Requires the existing local Ollama model; isolated synthetic state only.
$env:OPENCLAW_LIVE_KNOWLEDGE_CHAT='1'
node scripts/run-vitest.mjs run --config test/vitest/vitest.live.config.ts src/gateway/knowledge-chat.live.test.ts --maxWorkers=1
```

测试使用合成资料及临时数据库，覆盖存储重开、中文与字面查询、提交去重、修订冲突、历史、解释失效与人工保护、删除账本恢复、连接撤销、原位文件变化与越界拒绝。实际 MCP stdio 子进程已验证保存→搜索→纠正→删除，以及显式文件根内的原位读取；验收资料位于 `D:\Cache\MyCortex\mcp-acceptance`。

2026-11-15，实际 Codex CLI 在隔离目录以普通用户陈述自动提交了学习偏好和固定安排；另一个独立对话自动调用 `context`，按保存的信息回答。第三个对话只问算术，没有调用知识工具。通过 CLI 重新读取数据库，确认只保留一份材料，摘要与选定原话分开，举例及明确要求不保存的文本未进入正文。三个成功对话只配置 MCP 启动等待和工具审批，没有额外注入记忆提示词；服务端规则随 MCP 提供。合成验收记录位于 `D:\Cache\MyCortex\mcp-automatic-e2e`。这验证了该客户端的一组实际行为，其他客户端需独立验证。

2026-11-15，真实 Gateway 使用本机 `qwen3.5:9b-q4_K_M`、32,768 上下文、两个知识工具完成保存→新会话找回/引用→纠正→删除→再查，耗时 235.39 秒（含启动准备）。逐字原文、当前修订、历史及数据库删除状态均检查通过；删除后回答未再复述旧正文或来源。此前发现模型会从旧聊天补来源，已修正工具说明，保留原负向断言后复测通过；这一单次合成验收不等于模型稳定准确率评测。

五轮实际用量如下，取每个会话最后累计值再相加，包含工具往返、历史重发和缓存读取：

| 操作       | 本轮新增 tokens |
| ---------- | --------------: |
| 保存       |           7,763 |
| 新会话找回 |           7,819 |
| 纠正       |          14,677 |
| 删除       |          14,033 |
| 删除后再查 |          16,692 |
| 合计       |          60,984 |

其中新输入 10,221、缓存读取 49,359、输出 1,404。该流程没有启用自动整理；本地模型没有 API 账单，尚未测外部模型实际费用。当前限制结果长度，未实现全请求 token 硬预算；短材料也会产生既有运行时提示和多次调用开销。本机 9B 的初始 8K 配置曾因工具目录提示超过上下文而失败，示例因此显式关闭目录搜索并对齐实际 `num_ctx`。本次日志位于 `D:\Cache\MyCortex\knowledge-chat-current-evidence-2026-11-15.log`。

## 数据库升级与备份边界

数据库格式为 v2。首次打开 v1 库时，在同一事务内增加 `organizations` 派生视图表，并将尚存文本原件排入待整理队列；不改写原文或历史修订。原文纠正会清除旧解释并按新修订重新排队，删除同时清除解释。后台结果只有在原件修订仍匹配、引用及时间原话确实出现于正文时才可保存；自动结果不能覆盖已完成或人工纠正的解释。解释仍是来源的解读，其状态与修订会随检索结果返回。

旧程序遇到 v2 库会拒绝打开。需要回退旧程序时，使用升级前、已停止知识库操作时保存的整个数据库备份及配套旧程序，不要手动调低 `user_version`。当前验证对象为本机合成资料；首次升级现存原件会按条目数量写入待办记录。

可移植导出使用 `mycortex.materials` v2，包含原件、修订、删除标记，以及 `organizations` 中的人工解释、视图修订、处理状态和待办。导入前逐项检查来源当前修订与原文引用。旧 v1 原件导出仍可导入，缺失的文本解释重新排队；v1 没有保存过的人工解释无法恢复。完整数据库也可在所有知识库操作停止后备份。无论采用哪种备份，恢复时都需合并最新删除账本，防止旧备份重新带回已删除原件。
