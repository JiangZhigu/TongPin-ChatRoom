# M1 拟改文件、接口与阶段计划

日期：2026-09-11。本文全部是计划；M1 未开始。依据最新确定的 Python + Flask 后端，取消 Node 服务端和 Vercel 分支。

执行方式按 [FE-1 全流程总单](FULL_EXECUTION_BASELINE.zh-CN.md)：总单一次确认后，连续完成全部开发、验收、独立体验测试、修复和可部署交付。本文的阶段边界用于组织实现和自动检查，不是用户逐阶段批准点。

C3 已明确为全站超级管理员后台，并允许超管审阅私聊、群聊及附件，敏感访问留审计。完整范围与 SA01–SA14 清单见 [后台范围](M0_SUPER_ADMIN_SCOPE.zh-CN.md)。M1 预留其工程边界，完整功能在后续领域阶段和 M7-Admin 交付。

## M1 的可见结果

在当前项目根形成可启动的 Python 常驻服务与同频前端骨架：真实 /health/live、/health/ready；可重复、安全的 SQLite 基础迁移；数据目录、受限缓存和单实例锁；保留视觉 token。正式入口显示未登录/账号功能未启用的真实状态，不能用一个 mock 账号假装 M2 已完成。

M1 不交付真实注册、好友或发消息；这些在 M2/M3。M1 传输烟测使用隔离测试进程中的专用 fixture 验证 HTTP→WebSocket 升级，不向正常入口暴露任意 echo 或伪消息服务。

## 工程与数据位置

Python 代码采用根目录 pyproject.toml + src/tongpin，虚拟环境为根目录 .venv。前端保留 React/TypeScript/Vite 候选，放 apps/web；packages/contracts 只放生成的 TypeScript 和 schema 消费层。Python 用 uv 和 uv.lock，前端用 npm 和 package-lock.json，各生态唯一锁文件；不混入 pip 全局安装或第二个前端包管理器。

默认本地数据根 var/；数据库 var/data/tongpin.sqlite3，私有附件 var/private-uploads，临时接收 var/upload-tmp，演练备份 var/backups。路径可配置，始终由项目/配置根解析，源码更新不能替换数据目录。数据、.env、.venv、node_modules、构建产物、.codex 全部忽略。生产持久根在 M9 配置到版本目录以外。

## 拟新增 / 修改文件

以下均相对 F:/py/demo_chatroom；已有设计包不改写。确需新增文件会先检查是否已存在并保护用户差异。

| 拟改文件 | 责任与内容 | 对应 M1 |
|---|---|---|
| pyproject.toml、uv.lock、.python-version | Python 3.12.13 基线、运行/测试依赖、固定版本 | 01 |
| package.json、package-lock.json、tsconfig.base.json | 只管理前端 workspace、统一脚本与类型配置 | 01/02 |
| .gitignore、.env.example、README.md | 忽略本机数据、只放空白/安全开发配置样例、启动/限制/回退 | 02/04 |
| scripts/setup.py、scripts/dev.py、scripts/build.py、scripts/check.py、scripts/start.py | 跨平台编排；setup 幂等；优先根 .venv；从外部 cwd 可运行；只停止自身启动的子进程 | 02 |
| scripts/run-python.mjs | npm 入口调用根 .venv 的小型跨平台桥接；不承担后端业务 | 02 |
| src/tongpin/__init__.py、config.py、asgi.py、__main__.py | Flask app factory、显式配置验证、ASGI组合/lifespan、Uvicorn单进程入口 | 01/06 |
| src/tongpin/infra/db.py、migrations.py | sqlite3 连接/参数化/pragma、短事务、迁移 checksum/失败回滚 | 03 |
| src/tongpin/migrations/0001_infrastructure.sql | schema_migrations 引导/版本登记与 jobs 基础；M2–M7 逐域增加其它参考表 | 03/06 |
| src/tongpin/infra/paths.py、runtime_lock.py | 规范化路径、拒绝链接逃逸/危险目录、磁盘水位、跨进程单实例锁 | 04/06 |
| src/tongpin/infra/cache.py、executors.py、logging.py | 有界缓存/锁/时钟/单飞，有界阻塞任务执行器，脱敏日志 | 05/06 |
| src/tongpin/infra/metrics.py、config_contracts.py | 有界指标采集/快照接口、采样时间/未知状态、管理业务配置的类型和生效方式边界；具体后台配置模型后续按阶段迁移 | 05/06 |
| src/tongpin/jobs/repository.py、runner.py | 持久任务租约、去重/重试、有界唤醒和停机 | 06 |
| src/tongpin/transports/http/health.py、errors.py | 真实 live/ready、统一错误封装，不公开路径/配置 | 06 |
| src/tongpin/transports/http/admin/__init__.py、src/tongpin/contracts/admin_base.py | 预留 /api/v1/admin 命名空间与管理错误/请求ID；M2管理身份完成前关闭数据读取和写操作，不能返回伪管理员资料 | 01/06 |
| src/tongpin/transports/socketio/server.py | 显式 ASGI 传输、Origin及连接资源边界、async连接注册；正式业务授权 M2/M4补齐前不接受业务订阅 | 01/06 |
| src/tongpin/transports/asgi/body_limits.py | WSGI适配前限制实际字节/请求时长/并发，保护临时spool；未知路径不接受大体积 | 04/06 |
| src/tongpin/contracts/base.py、scripts/export_contracts.py、packages/contracts/src/generated.ts | Python运行时schema→JSON Schema/TS；仅健康/错误等M1契约；其它业务按阶段补齐 | 01 |
| apps/web/package.json、vite.config.ts、tsconfig.json、index.html、src/main.tsx | 前端入口、代理/api/v1与/socket.io、构建静态资源 | 01/07 |
| apps/web/src/app/App.tsx、AppShell.tsx、AuthGate.tsx | 浅灰浅蓝框架、未登录/未启用空态、移动导航 | 07 |
| apps/web/src/admin/AdminShell.tsx、AdminGate.tsx、AdminUnavailablePage.tsx | /admin独立管理导航与真实未启用状态；不得以静态指标或固定列表冒充全站后台 | 07 |
| apps/web/src/components/NavigationRail.tsx、ConversationList.tsx、ChatHeader.tsx、MessageTimeline.tsx、Composer.tsx | 从原型抽出纯展示层；正式数据不设演示默认值 | 07 |
| apps/web/src/styles/tokens.css、app.css、src/assets/logo.svg、src/components/Icon.tsx | 迁移现有token/视觉资产；保持license | 07 |
| apps/web/src/adapters/api.ts、src/dev/PrototypeRoute.tsx、src/dev/fixtures.ts | 正式API与开发演示分离；生产构建不可导入demo；演示路由仅开发 | 07 |
| tests/conftest.py、test_config_paths.py、test_db_migrations.py、test_cache.py | 临时目录、迁移/缓存/配置定向测试 | 03–05 |
| tests/test_runtime_lock.py、test_jobs.py、test_health.py、test_asgi_transport.py、test_body_limits.py | 第二进程拒绝、租约恢复、真实HTTP/WS、chunked限额 | 06 |
| tests/test_metrics.py、test_admin_disabled.py | 指标容量/采样未知状态、未启用管理接口不可读取站点数据；不提前写不存在的后台业务测试 | 05/06 |
| apps/web/src/app/App.test.tsx、tests/e2e/m1-shell.spec.ts | 未登录/服务不可用/视口基本行为；有真实服务后才跑浏览器 | 07 |
| implementation/STATUS.md、M1_DELIVERY.zh-CN.md | 实际文件、版本、运行结果、证据/未测项与自动推进结果 | 全部 |

这是拟改文件，不是当前已创建文件。若实现需要调整模块名，先更新此清单和路径所有权；不借 M1 扩成全部聊天代码。本轮没有 Git 元数据写入。

用户现已创建远端 [JiangZhigu/TongPin-ChatRoom](https://github.com/JiangZhigu/TongPin-ChatRoom)：main 初始提交 4a195bc091429f6fc06cc79ce116117d53f4b1c0，含 README.md、.gitignore、Apache-2.0 LICENSE。FE-1 获确认后由 git-keeper 先核对远端更新，安全建立本地关联并保留这段历史；对远端同名文件做合并补充，保护现有设计包和 implementation，保留用户已确认的 plan_doc 删除，不另起无关历史强推覆盖。git-keeper 只做本地提交；主智能体依 FE06 的一次公开交付授权核对范围后推送。总单尚未获确认时不推送。

## M1 接口与内部边界

| 接口 | 计划语义 |
|---|---|
| GET /health/live | 进程在响应即200；不读私密数据 |
| GET /health/ready | 实际配置、迁移、可写数据库/磁盘和锁已就绪才200，否则503；公开输出最小状态 |
| /api/v1/* | Flask Blueprint；错误为设计包 Result/APIError 形态，身份未实现时明确拒绝，不能返回假成功 |
| /socket.io | python-socketio/Engine.IO升级；transport与HTTP共用领域service、认证/策略；M1隔离fixture可测升级，正式业务禁用 |
| /api/v1/admin/*、/admin | 管理API和前端独立入口；M1只保留边界/未启用状态，M2后增加独立站点授权；普通群角色无管理授权 |
| Database | 每线程/每操作连接，begin_immediate回调内完成事务；不跨await或把连接传其它线程 |
| MemoryCache | get/set/delete/get_or_load；namespace、条数/字节/TTL、注入时钟、线程安全；无命中时回源 |
| JobRepository/Runner | enqueue/claim/complete/fail/lease；失效租约重领、幂等、停止后可重启 |
| BlockingExecutor | 总并发和等待队列有界；async侧不直接执行sqlite/Argon2/Pillow；背压拒绝明确 |

M1 只转换基础表，保留 schema_migrations 的不可改写版本/checksum 与 jobs。参考 schema.sql 的所有用户/消息/权限表分阶段迁移，避免一次生成28表后冒充领域规则已实现。跨域约束在实际引入的同一阶段测试。

## M1 执行顺序与交付门槛

1. 核对 FE-1 全流程总单及用户例外的一次确认记录；C3 全站后台和私聊/群聊/附件审阅已明确。检查当前目录差异和 Git 状态。获确认后后续阶段按自动质量门槛推进，不再逐阶段请求批准。
2. 项目内创建 .venv、锁 Python 和前端依赖；分别记录安装/导入，验证 sqlite3实际版本、Argon2id和Pillow。配置缓存到项目内，不改全局环境。
3. 基础迁移/私有目录/缓存/锁/jobs/健康入口；先做失败路径再接前端。生产 debug=false、reload=false、workers=1。
4. 接入 Flask→ASGI 和 Socket.IO，明确安装 WebSocket 协议依赖，并从真实 HTTP 升级到 WS；核查 HTTP 并发、健康检查/高成本隔离负载与 WS 心跳共存，断连与关闭可释放自身资源。适配器串行化若不达门槛，更新 ADR 后调整受限适配方式，不能直接开多 worker。
5. 迁移纯UI与空态，开发演示独立；桌面/手机与既有预览对照。为/admin保留独立入口和未启用状态，不改变聊天页为管理控制台。
6. 执行下列定向检查并落盘；若发现公共契约/持久化跨模块风险定向证据不足，再登记必要全量回归，不机械运行所有角色。

M1 最小测试集：干净安装与二次setup；从项目外目录启动；根.venv实际解释器；真实HTTP及WS101；迁移重复执行/失败回滚/checksum不符拒绝；WAL/FULL/FK/busy_timeout真返回；重启保留基础记录；第二进程拒绝及崩溃锁释放；cache条数/字节/TTL/并发/重启清空；job租约重领；body chunked超限/未知长度超限；生产关闭demo；6种视口与服务失败空态。

三系统需每个平台的安装/启动/WS/SQLite/缓存结果。当前本机为 Windows；FE06 在本次整体确认中纳入公开仓库标准免费 Windows/macOS/Linux CI。执行前核对运行器和费用边界；平台缺项标未测并解决，不以依赖 wheel 存在宣称通过。CI 与物理设备/输入法证据分别记录。

M1 检查通过后更新交付记录并自动进入 M2；其他阶段同理。测试失败、审查意见和范围内缺陷由主智能体修复/复测；不把阶段报告当成需要用户回复的批准单。

回退：保留原设计包；新工程目录和清单只撤回本批文件；失败迁移回滚，不删数据。升级时先备份到新位置，再以新代码/新环境验证；可退版本与不可逆迁移明确列出。

## M2–M9 阶段排程

| 阶段 | 交付闭环 | 独立验证重点 |
|---|---|---|
| M2 | 注册/登录/CAPTCHA/Argon2id/会话/恢复码/设备/再认证；超管初始化、独立站点权限、强制TOTP/管理恢复、人工账号恢复与基础审计（按FE03总单规则） | 两客户端、一次消费与重放、Cookie/CSRF、重启、会话/WS撤销；最后超管保护、群角色不能提权 |
| M3 | 好友、DM、真实持久文字、幂等seq/ACK；全站账号/关系/会话索引与治理策略 | 并发唯一DM、身份伪造/第三人拒绝、commit后ACK、刷新重启；管理查询与普通用户策略分离 |
| M4 | 双向离线、IndexedDB、多标签页/多设备、游标/presence；全站会话监控、强制下线与采集事件 | ACK丢失、跨账号队列、快照空档、只关一标签、隐私与提醒；管理操作在HTTP/WS同步生效 |
| M5 | 群、邀请/审核/名额、成员期、权限、禁言/转让/解散；超管跨群处置与审计 | owner/admin/member/陌生人/退出者、并发最后名额和撤权；独立超管权限与管理撤销 |
| M6 | 真实附件/图片/下载/Blob恢复/容量；全站附件索引/配额/隔离/清理和受控内容审阅 | 双方字节一致、重启保留、chunked/魔数/解码/权限/磁盘不足；超管访问审计、导出和删除保留策略 |
| M7 | emoji/引用/@/reaction/撤回/收藏/搜索、通知、移动端、安全设置、按FE04规则的账号注销/冷静期/到期清理 | 中文/ZWJ、IME、真实阅读、焦点/软键盘、注销权限/保留和前台完整闭环 |
| M7-Admin | SA01–SA14全站超级管理员后台完整页面、真实API/实时数据和管理操作；监控告警、配置/公告、内容治理、审计/权限、任务/备份 | 各模块可下钻、筛选/批量操作真实执行，管理动作与前台状态一致；敏感读取可追溯、配置生效和运维结果可核实 |
| M8 | 综合/故障/安全/恢复/负载/三平台验收与交付文档；原A–G加SA01–SA14后台清单 | 同一冻结版本、明确未测项、独立验收；交付Windows/macOS/Linux与Docker脚本；前后台联动与超管越权负向验证 |
| UX-POST | M8验收后另起同等级Astra，browser-use测试聊天室和完整全站后台 | 前台用户旅程及SA01–SA14逐模块管理体验、困惑/死按钮/恢复路径、真实页面证据和缺陷分级 |
| M9 交付准备 | FE-1确认后自动完成发布预检、配置模板、交付包和隔离升级/回滚演练 | 运行/管理说明、校验值、持久目录/服务管理/反代模板；保留未执行的线上项 |
| M9 实际上线 | 默认不在FE-1推荐授权范围；本次若补齐环境并明确纳入则按该授权实施 | 主机/费用/域名/生产持久盘/独立备份/条款和运营信息；真实线上多客户端烟测 |

G09脚本计划路径：deploy/windows/start.ps1、deploy/windows/start.cmd、deploy/macos/start.sh、deploy/linux/install.sh、deploy/linux/rollback.sh、deploy/docker/Dockerfile、deploy/docker/compose.yaml。脚本应检测环境/发行版、保留旧版本与数据、幂等设置；生成脚本不等于已在三个系统或生产实际部署。Docker是可选交付，不是本地开发前提。
