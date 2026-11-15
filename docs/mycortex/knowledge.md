# MyCortex 知识材料库：本地预览

这版可以保存 UTF-8 文本/Markdown、保存链接、搜索原文、读取材料、纠正、删除、导出和恢复。输入是明确选择的文件或链接，输出是带来源与修订号的 JSON。操作不调用模型，模型 token 消耗为 0。

代码位于 OpenClaw 核心 `src/knowledge`，知识数据独立于聊天和 Agent。当前用合成资料验证，生产加密方式尚待确定。

## 启动

需要 Node.js 24.16+（符合根 package.json 的版本范围）及已安装的项目依赖。当前开发机已安装依赖，缓存位于 `D:\Cache\MyCortex`。

在 PowerShell 中运行：

```powershell
cd D:\Desktop\MyCortex\core
& .\scripts\knowledge.ps1 --help
& .\scripts\knowledge.ps1 --store D:\Cache\MyCortex\demo init
```

每次显式指定 `--store`，数据文件是该目录下的 `knowledge.sqlite`。工具不会使用默认 OpenClaw 状态目录。数据库 v1 只在空文件初始化；已有其他格式或不支持版本会拒绝打开。

## 保存和查询

先创建一份合成测试文本：

```powershell
Set-Content -Encoding utf8 D:\Cache\MyCortex\demo-note.txt '合成材料：测试项目计划周一完成。'
& .\scripts\knowledge.ps1 --store D:\Cache\MyCortex\demo add `
  --file D:\Cache\MyCortex\demo-note.txt `
  --title '合成项目计划' --source 'synthetic:project-note' `
  --author 'synthetic-user' --request 'demo-note-1'

& .\scripts\knowledge.ps1 --store D:\Cache\MyCortex\demo search '周一'
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
& .\scripts\knowledge.ps1 --store D:\Cache\MyCortex\restored-demo init
& .\scripts\knowledge.ps1 --store D:\Cache\MyCortex\restored-demo import `
  --file D:\Cache\MyCortex\demo-backup.json
```

导出是含历史和删除标记的明文 JSON，最多 32 MiB、10,000 个材料、100,000 个修订。目标文件必须不存在。导入校验格式、来源正文约束、完整修订序列和原始提交指纹，原子写入空库；拒绝覆盖已有材料的库。

备份恢复的是导出当时状态。删除前导出的备份仍可能包含已删除内容；这版只提供新目录恢复，不提供原库回滚或合并。真实数据恢复前还需要实现与最新删除记录及授权的合并。超过导出上限时，停止使用该库的命令后，可保留完整 SQLite 文件作为离线备份。

## 当前范围

- 本地操作者通过显式文件和目录操作；没有网络监听、外部 AI 授权接口或后台采集。
- 同一目录的命令通过已有进程锁串行执行，写入使用同步事务，成功后才返回 JSON。
- 暂无自动语义整理、自然语言问答、MCP、文件原位索引、PDF/Word 解析、图形界面和 E2EE。
- 数据模型保持来源开放，不设置学历、健康等固定领域。

## 验证

```powershell
node scripts/run-vitest.mjs src/knowledge/store.test.ts src/cli/knowledge-cli.test.ts --maxWorkers=1
```

测试使用合成资料及临时数据库，覆盖存储重开、中文与字面查询、提交去重、修订冲突、历史、删除、防旧提交恢复、导出/导入及损坏导入拒绝。另已通过开发机独立进程的保存→搜索→纠正→导出→删除→拒绝旧提交→新库恢复流程。
