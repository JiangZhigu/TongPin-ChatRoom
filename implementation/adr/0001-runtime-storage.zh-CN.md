# ADR-0001：Flask 常驻服务、SQLite 与进程内缓存

日期：2026-09-11  
决策状态：提议，汇入 [FE-1 全流程总单](../FULL_EXECUTION_BASELINE.zh-CN.md)一次确认。Python + Flask 后端及取消 Vercel 已由用户确定，无需再次确认；总单确认后自动连续实施，不逐阶段批准。  
依据：用户当前指令、v2 PRD/ARCHITECTURE、[M0 事实](../M0_REPOSITORY_FACTS.zh-CN.md)、[官方依赖调查](../M0_DEPENDENCIES.zh-CN.md)。

## 背景与工程选择

当前只有 UI 原型和参考契约，没有可复用的真实后端。用户确定 SQLite、三系统进程内缓存、账号与实时通信/离线/文件功能，并要求保留同频布局。进程退出、网络断线和权限变化必须有明确处理。

提议根目录 Python 3.12.13 项目 .venv，pyproject.toml + uv.lock 管理后端；src/tongpin 使用 Flask app factory。前端为 apps/web 的 React/TypeScript/Vite，npm workspaces 仅管理前端及生成契约，单一 package-lock.json。Node 只用于前端工具链。Python 运行时 schema 为接口验证来源，生成 JSON Schema/TypeScript，避免手工维护两套规则。

## 单进程 HTTP 与实时传输

Flask 承担 HTTP API 和业务入口；asgiref.WsgiToAsgi 将其接入 ASGI；python-socketio.AsyncServer(async_mode='asgi') 通过 socketio.ASGIApp 与 Flask 组合，由 Uvicorn 单进程运行。使用跨平台 asyncio、h11 和明确安装的 WebSocket 协议实现，不把可选 uvloop 作为 Windows 依赖。此组合有官方支持；本轮没有安装或启动验证。[Flask ASGI 部署](https://flask.palletsprojects.com/en/stable/deploying/asgi/)、[python-socketio ASGI](https://python-socketio.readthedocs.io/en/latest/server.html#asgi)、[Uvicorn](https://www.uvicorn.org/)。

~~~mermaid
flowchart TD
    U[浏览器 React / 按账号隔离 IndexedDB] -->|同源 HTTPS / WSS| A[Uvicorn 单进程 / 资源边界]
    A --> S[Socket.IO ASGI / 活连接注册表]
    A --> W[受控 WSGI 适配 / Flask HTTP]
    S --> D[统一领域服务 / 有界阻塞执行器]
    W --> D
    D --> DB[(SQLite / WAL / 本地持久盘)]
    D --> F[私有附件与临时接收目录]
    D --> C[线程安全有界进程内缓存]
    DB --> B[一致性备份与附件清单]
    F --> B
~~~

HTTP/Socket.IO 共用领域服务、校验和权限策略；不得各写一套消息/群规则。SQLite、密码散列、图像解码都是同步工作，使用有界执行器，禁止在 async 事件循环直接执行或跨 await 持有事务。连接/房间映射留在 async 一侧，通过明确调度调用，不在 Flask 线程直接修改活 socket 集合。[Flask 异步限制](https://flask.palletsprojects.com/en/stable/async-await/)。

asgiref 3.12.1 会先收取请求体，超过其 64 KiB 内存阈值后使用临时文件，之后才调用 Flask；因此仅设置 Flask MAX_CONTENT_LENGTH 不足以保护前置接收。M1 必须在适配器之前按实际累计字节、时间、并发和路径限制请求；M6 上传还要在收大体积正文前完成鉴权/额度预检，临时目录置于受控私有路径。Content-Length 只作辅助，chunked/未知长度也必须受限。[对应版本源码](https://raw.githubusercontent.com/django/asgiref/3.12.1/asgiref/wsgi.py)。

适配器的线程敏感调度可能串行化 Flask 请求。M1 必须用真实并发请求核查健康检查、登录模拟负载与 WS 心跳；如不能满足首期门槛，调整受限适配执行方式并先更新 ADR，不能用多 Uvicorn worker 掩盖而拆分 presence。具体适配并发参数是 M1 技术验证项，尚非已验证能力。

## 路径与持久数据

M1 默认只监听 127.0.0.1。默认数据库 var/data/tongpin.sqlite3，附件 var/private-uploads，临时接收 var/upload-tmp，演练备份 var/backups。配置接受 DATA_DIR、UPLOAD_DIR、BACKUP_DIR、UPLOAD_TMP_DIR；相对路径锚定项目/配置根，数据库文件由 DATA_DIR 派生。本轮没有创建这些业务目录或数据库。

正式数据根必须独立于版本目录，位于本机持久磁盘并通过 ACL/文件权限保护。拒绝 public/dist、临时目录、NFS/SMB、同步盘或随发布替换的目录。启动检查规范化真实落点、链接逃逸、权限、可写性和磁盘预算。Windows ACL 与 POSIX chmod 分别说明，不宣称等价。

M1 建基础迁移与 jobs，M2–M7 逐域将参考 28 表转换成正式迁移。迁移版本/checksum 固定，重复启动不重放、不改旧迁移；失败回滚或提供前向修复，不自动删库。原设计包不覆盖、不重新打包。

## SQLite、单实例与任务

使用 Python 标准库 sqlite3；每线程/每次操作创建并关闭其连接，保留 check_same_thread=True，不跨线程传连接。每连接核验 foreign_keys=ON、journal_mode=WAL、synchronous=FULL、busy_timeout=5000；参数化 SQL，写事务短 BEGIN IMMEDIATE，串行写队列/锁有界。网络、散列、图片处理置于事务外。[Python sqlite3](https://docs.python.org/3/library/sqlite3.html#sqlite3.connect)。

WAL 仍只有一个 writer；长读、checkpoint、写等待需观测。数据库版本是所选 Python 实际绑定的 SQLite，不能拿 PATH 的旧 sqlite3 CLI 代替。FULL 提高提交持久性但不构成任意硬件/断电条件下绝不丢失的承诺。[SQLite WAL](https://www.sqlite.org/wal.html)、[同步设置](https://www.sqlite.org/pragma.html#pragma_synchronous)。

WORKERS=1，生产 reload/debug 均关闭。使用 portalocker 对规范化数据根持有操作系统文件锁直到退出，配合所有者信息诊断；锁文件内容不是锁的权威。第二实例有限时间内拒绝，异常退出后由 OS 释放；不凭“文件存在”或随意删除文件判断有效锁。跨平台实测锁语义和链接别名，后台任务不能另开一个不受控应用实例。[portalocker](https://portalocker.readthedocs.io/)。

jobs 存 SQLite，带 dedupe_key、租约、重试和失败状态；定时唤醒只触发检查，不能成为任务唯一保存位置。有界密码/图片工作线程不拥有独立 HTTP/presence 服务，队列满时显式背压。

## 缓存与权限

使用 cachetools 包装 MemoryCache，统一 get/set/delete/get_or_load；命名空间、注入时钟、线程锁、同 key 单飞加载、条数和估算字节双限、TTL 与定期回收。库缓存对象本身不线程安全，不能直接跨 Flask 和 Socket.IO 线程访问。[cachetools 文档](https://cachetools.readthedocs.io/)。

查询缓存暂定 10,000 项、64 MiB、30–60 秒 TTL；验证码用独立有界缓存，120 秒过期，重启失效。活 socket 注册表独立且有上限，不能被 LRU 淘汰成假离线。验证码和缓存失效只能导致重新挑战/回源。

SQLite 是账号、会话摘要、权限/屏蔽、消息、邀请计数、持久限流、同步事件和 jobs 的权威。敏感操作复核当前权限；关系变更提交后立即失效缓存、撤销 room 订阅；广播和补拉再授权。不能用 TTL 窗口容忍失权后继续读私聊/群消息。

## 两类离线与真实 ACK

接收者离线：消息、seq、附件关联、user_events 与后续 job 在同一事务提交后 ACK；恢复时按 cursor 补拉。Socket.IO 默认 at-most-once 不代替持久消息或 exactly-once 业务语义。[官方投递保证](https://socket.io/docs/v4/delivery-guarantees/)。

发送者断网：先成功写入按 userId 隔离的 IndexedDB 文字/Blob，再显示等待网络；恢复后先核验会话/权限并同步服务端，再按会话 FIFO 提交。固定 clientMessageId 与规范化 payload_hash；重试同 payload 返回同一消息，冲突 payload 拒绝。ACK 丢失是结果未知，保留 ID 重试或查询。

快照与 cursor 一致；订阅窗口缓冲实时事件、补拉后去重，过期 cursor 返回 RESYNC_REQUIRED。已读只在真正可见阅读时推进。群成员失权覆盖 HTTP/WS/搜索/引用/收藏/附件；多标签页用租约选投递者，服务器唯一约束兜底。

## 同源、身份、附件与后台

构建静态前端由常驻服务或同一反向代理提供；/api/v1 和 /socket.io 同源。开发 Vite 代理两条路径；生产 HTTPS/WSS。使用 host-only opaque Cookie，HttpOnly/Secure/SameSite=Lax；写操作 Origin + CSRF。WS 校验会话和短时一次票据，长期凭据不放 URL。本期不采用跨站托管组合。

M2 使用 argon2-cffi 的 Argon2id、服务端 CAPTCHA、一次性恢复码和设备会话。M6 使用 Pillow 受限解码/重编码图片；其他允许文件保持不透明下载，检查魔数/类型/限额、随机存储 key，并对每次下载授权。公网文件能力需真实扫描/隔离或继续收紧格式；未扫描不得返回假 clean。

C3 已由用户明确：独立 /admin 全站超级管理员后台，覆盖整个 Chatroom 的监控和管理；私聊、群聊及附件均可审阅，敏感访问留审计记录。完整模块为 [SA01–SA14](../M0_SUPER_ADMIN_SCOPE.zh-CN.md)，包含全站账号/会话/关系/群组/内容/附件、配置、公告、管理员权限、日志审计和运维任务。前台聊天布局保留，后台复用视觉token但使用独立管理导航。

管理接口 /api/v1/admin 与管理WS订阅采用独立站点授权，不依赖群主/管理员身份。超管对全站数据的显式管理策略和普通用户读写策略分开；仅在管理身份、会话/再认证与具体权限有效时允许跨群/跨账号读取。敏感读取和管理动作均审计；撤权/封禁/会话撤销需在HTTP、WS、附件和导出链同步生效。超管初始化无默认密码，最后一个可用超管受保护。

业务配置与版本、审计、处罚、工单、公告和管理任务持久化到SQLite。指标采集采用有界采样/聚合及保留期，展示真实采样时刻与未知状态；监控不能绕过持久消息事务或产生无限内存增长。运维操作经有界任务执行并给出真实结果；重启/升级由实际启动管理链协调。后台完整交付安排为M7-Admin，并在M8和验收后Astra体验测试中逐模块核查。

## 备份、退出与验收

使用 sqlite3.Connection.backup 的在线备份能力，配合附件清单/hash、保留期和 GC 协调；不直接复制在线主 db 文件。恢复到新目录，校验版本、外键、内容和附件后启动，保留旧目录回退。开发同盘备份只用于演练，生产需要另一故障域。[SQLite 在线备份](https://www.sqlite.org/backup.html)。

live/ready 分开，ready 以迁移/数据库可写/磁盘和实例锁为依据；日志脱敏。退出时停止接收，有限等待事务/任务，再关闭 WS、执行器和连接；Windows 正常停止和强制结束分别验证。

M1 验证基础设施，M2–M7 闭合业务，M8 对冻结版本综合验收，随后另起与主智能体同思考等级的 Astra 子智能体做 browser-use 完整体验测试，自动修复/复测并完成 M9 交付准备。三系统和 Docker 部署脚本属 M8 交付；实际生产部署默认不在 FE-1 推荐范围，用户若本次指定环境并纳入则按该次授权实施。

## 代价与重新决策条件

单实例简化权限、缓存与 presence，但主机故障/维护会中断服务；本机睡眠或关机也会离线。SQLite 单 writer、Flask 适配并发、Pillow/Argon2 平台包均需真实验证，不承诺未经测量的人数、吞吐或可用率。

首期不引入 Redis、外部队列、多实例或另一数据库。实测写等待、ACK 延迟或恢复目标不达标时先更新 ADR并在既定边界内修复；不能擅自改掉 Flask/SQLite 底线。实际部署所需主机、预算、域名与独立备份按FE08的一次范围决定处理，不阻塞默认的可部署交付。
