# M0 仓库与环境事实

核查日期：2026-09-11；任务 tongpin-m0-20260911-01a08d87。此文记录本轮观察，架构选择见 ADR，不把建议写成已有实现。

## 项目位置与现有内容

真实工作根为 F:/py/demo_chatroom，当前目录及设计包目录均是普通目录，未发现 junction/符号链接。开始时共 61 个文件：设计包 58 个、plan_doc 2 个、设计包 ZIP 1 个。

| 位置 | 实际内容 | 对实施的影响 |
|---|---|---|
| tongpin-chat-product-v2/ | v2 UI 分离源码、文档、参考契约、22 张预览、原型 QA 和打包 HTML | 作为视觉与需求输入；不是已经可运行的聊天后端 |
| plan_doc/（开始时存在，交付时已删除） | 旧版 CODEX_TASK.zh-CN.md 与 QA_REPORT.zh-CN.md | 旧任务写匿名、不注册、不做数据库/附件；用户在执行期间主动清理并明确确认，保留删除状态 |
| tongpin-chat-product-v2.zip | 已有交付归档 | 未解包覆盖现有目录、未重建、未上传 |

在 F:/AGENTS.md、F:/py/AGENTS.md、项目 AGENTS.md、项目 .codex/AGENTS.md 与项目内嵌套 AGENTS.md 均未发现实际文件；执行用户消息给出的 AGENTS 规则及显式启用的 personal-subagents。

项目根不属于 Git 仓库，设计包内也没有 .git。没有可报告的本地分支、remote、upstream、提交 SHA 或未提交 diff；不能声称工作树干净。M0 写入前对所有 61 个原有文件保存了 SHA-256。没有自行 git init、拉取、提交或推送。后续用户创建的远端状态单列于文末，不等于本地已建立关联。

交付复核发现原有 59 个文件内容一致，plan_doc 中上述 2 个文件已不存在。用户随后明确回复“是，我删除了旧版文档”。这是已确认的用户清理，主智能体未写入/删除该目录，也未还原。最初“61 个全部保持不变”的检查差异保留为历史记录，最终按“59 个不变 + 2 个用户确认删除”核验，不修改初始基线。

未发现 package.json、lockfile、pyproject.toml、requirements、node_modules、项目 .venv、Dockerfile/Compose、已有数据库文件或 .openai/hosting.json。项目 .codex 与 implementation 均为本轮新建记录目录。检查范围是当前工作根，没有搜全盘找另一个项目或数据库。

## 已阅读的依据

完整阅读入口包括 README、handoff/CODEX_TASK.zh-CN.md、docs/PRODUCT_REQUIREMENTS.zh-CN.md、docs/ARCHITECTURE.zh-CN.md、design/UI_SPEC.zh-CN.md。为 M1 计划补读 DATA_MODEL、ACCEPTANCE 与配置样例；文档研究角色补读 SECURITY、SOURCES 和官方资料。

当前 handoff/ACCEPTANCE.zh-CN.md 的大小/哈希不同于包内 MANIFEST.json：原清单记录 7,943 字节，当前文件 8,105 字节。当前文件包含 G09（三系统一键部署脚本和 Docker 脚本）。57 个 manifest 条目中仅此条不匹配；作为现存工作保留，不用 ZIP 或原 manifest 覆盖，也不声称全部原型证据与当前文件完全对应。

## 前端源码到页面的实际路径

ui/index.html 加载 styles.css、icons.js、../assets/emoji-data.js 和 app.js，入口为页面内的 app/modal/popover/toast 容器。没有 React、Vite、真实认证 API、Socket.IO 后端或可运行 npm 脚本。

| 源码证据 | 当前行为 | 正式版处理 |
|---|---|---|
| ui/app.js:13–15 | tongpin-v2-demo 前缀 localStorage | 不能替代带账号隔离的 IndexedDB outbox/Blob |
| ui/app.js:20、29、54 | 古哥、12 人/5 在线、authenticated=true | 只作为开发演示 fixture；正式入口来自真实会话与统计 |
| ui/app.js:119–120、164 | 发送/重连/重试在本地变为 accepted | 替换为服务端事务提交后的 ACK 与幂等重试 |
| ui/app.js:138–140 | File/Object URL 预览与本地进度 | 替换为真上传/解码/鉴权下载，刷新后 Blob 可恢复 |
| ui/app.js:141–143 | 客户端比较验证码、直接登录演示账号、演示恢复码 | M2 后端 CAPTCHA、密码散列、会话与一次性恢复码 |
| ui/app.js:281 | window.TP 暴露状态与 getCaptcha | 正式构建中移除，开发演示不能被生产 import |

app.js 92,490 字节、styles.css 37,452 字节、icons.js 3,356 字节、index.html 716 字节。使用分离源码定点看符号与样式；未将 864,888 字节 preview.html 或 286,452 字节 emoji 字典全文载入上下文。

Emoji metadata 为 2,810 个独立序列、3,608 个别名，来自 Rich 15.0.0/MIT；不是 Unicode/CLDR 全量保证。正式数据固定版本与许可证在 M7 交付。

## 已查看的界面基线

人工打开现有预览 01-desktop-chat、02-register、09-group-owner、11-offline-outbox、14-mobile-chat。确认浅灰画布、浅蓝自己气泡、白色接收气泡、窄导航/会话列表/聊天/可选详情、群管理模态和移动单列形态。

保留主色 #008fed、正文 #243343、自己气泡 #cfedff；桌面导航 72px、列表 298px、详情 288px；720px 移动断点、1200px 详情抽屉断点。正式组件建议见 UI_SPEC，M1 按源码 token 迁移。没有本轮重新渲染或操作聊天室。

## 本机依赖与磁盘

| 项目 | 本轮实际观察 | 判断 |
|---|---|---|
| 系统 | Windows x64，内核 10.0.26200；PowerShell 7.6.5 | 本轮只有此平台 |
| Node | F:/node/node.exe，24.15.0，ABI 137 | 已安装；只用于前端构建，M1 固定版本，不作为后端 |
| npm / corepack | npm 11.12.1；corepack 0.34.6 | npm 可运行；选单一 npm，不因 PATH 另有 pnpm 混用锁文件 |
| PATH Python | C:/Program Files/Python311/python.exe，3.11.8 / SQLite 3.43.1 | 项目无 .venv；用于只读盘点、内存参考 DDL 和 M0 文档检查 |
| 另一已安装 Python | C:/Users/JZG/AppData/Roaming/uv/python/cpython-3.12.13-windows-x86_64-none/python.exe；3.12.13 / SQLite 3.53.1，x64 | 已实际执行查询；建议 M1 用它创建项目 .venv；本轮未创建 |
| uv | D:/SoftWare/hermes/hermes/bin/uv.exe，0.11.27 | 已实际执行版本查询；M1 仅管理项目环境，不改全局 Python |
| SQLite CLI | F:/platform-tools/sqlite3.exe，3.32.2 | PATH 上的旧工具不等于 Python 绑定的 SQLite，不作后端运行基线 |
| F: | 本地 NTFS，Healthy，观察时剩余约 8.47 TiB | 有本机空间不等于长期生产主机或独立备份已落实 |
| 项目依赖 | 未建立项目依赖环境；Flask、python-socketio、Argon2、Pillow、cachetools 尚未在项目内安装 | 官方兼容性和实机安装结果分开记录；sqlite3 来自标准库 |
| 浏览器工具 | Browser Use 控制能力可调用；Edge、后续指定的内置浏览器均未成功读取页面 | Python browser_use 模块与 browser-use CLI 未安装，但不能由此推断应用内 Browser Use 不存在 |
| GitHub CLI | gh 未找到 | 已有 GitHub 连接器不暴露新建 repository 方法 |

## 本轮真实检查与限制

- node --check ui/app.js、ui/icons.js 均退出 0，仅语法检查。
- Python 3.11.8 / SQLite 3.43.1 在 :memory: 执行参考 DDL：28 个业务/基础表，foreign_keys=1，foreign_key_check 返回 0 条。没有写数据库文件。首次命令引用转义错误在执行 SQL 前失败，修正为安全多行输入后完成；未隐藏为一次成功。
- Manifest 核对为 56 条匹配、1 条当前验收文件不同；没有改写 manifest。
- 原 QA 声称 102 UI/16 DDL 通过，是设计作者环境的历史证据；未复跑整套，不能抵扣账号、真实消息、持久化、文件或跨系统验收。
- 未运行服务器、安装依赖、构建产品、生成密钥、启动数据库迁移、部署或执行恢复演练。

## GitHub 追加请求

用户先授权已登录 Edge 创建仓库，后明确改用已登录 GitHub 的内置浏览器，页面为 github.com/new。计划默认私有 tongpin-chat、空仓库；未选择公开、模板、许可证、付费项或上传设计包。

当时调用创建浏览器标签、列举状态及重置后列举均报 nodeRepl.fetch request failed；没有拿到 GitHub 页面和登录账号，未填写/提交创建表单。官方只读诊断显示 Edge 在运行，默认配置的 ChatGPT 扩展已安装且启用，native-host manifest 检查正常。当时只能确认浏览器连接故障，不能据此声称已建库或直接归因为缺扩展。

已经给出[官方 Edge 连接步骤](https://learn.chatgpt.com/docs/chrome-extension)。用户改用内置浏览器后，创建内置标签调用 30 秒超时并自动重置会话，随后列举页面状态仍报 nodeRepl.fetch request failed。两条浏览器连接流程共 5 次调用均未返回可操作页面，提交创建动作 0 次。内置浏览器连接故障不等同于 GitHub 未登录；该阶段没有账号名、仓库 URL 或成功创建证据。用户后续自行创建及只读验证结果如下。

未改浏览器权限、安装组件或读取凭据；未使用其他自动化路径绕过当前浏览器控制接口。

之后用户明确提供已自行创建的仓库：[JiangZhigu/TongPin-ChatRoom](https://github.com/JiangZhigu/TongPin-ChatRoom)。本轮通过公开页面读取与 git ls-remote 只读确认：Public、默认 main、1 个初始化提交，包含 .gitignore、LICENSE（Apache-2.0）、README.md；远端 HEAD/main 为 4a195bc091429f6fc06cc79ce116117d53f4b1c0。这个实际状态取代先前私有空仓库默认建议。

创建由用户完成，主智能体没有提交建库表单。仓库存在已验证，本地仍无 Git 关联；[FE-1总单](FULL_EXECUTION_BASELINE.zh-CN.md)整体获确认后，在M1安全关联并保留初始化历史及用户文件，不能建立无关历史后强推覆盖。当前浏览器连接故障留作后续体验工具准备项，不再阻碍仓库存在这一条件；仓库消息本身不构成实现或公开代码推送批准。用户随后明确一次确认后连续开发，按FE-1集中确定范围。
