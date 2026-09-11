# M0 依赖、兼容性与官方依据

核查日期：2026-09-11。本轮是只读研究和已有解释器盘点，没有创建虚拟环境、安装应用依赖或启动服务。表中版本是本轮核对的候选；M1 经干净安装和组合验证后写入锁文件，不能仅凭版本表声称可运行。

用户已明确 Python + Flask 后端、不采用 Vercel。后端不使用 Node、Express、better-sqlite3、sharp 或 lru-cache；前端仍建议 React/TypeScript/Vite。原设计包保持不变，以本 M0 决策为后续实施依据。

## 本机可以复用的环境

| 环境 | 本轮事实 | M1 用法 |
|---|---|---|
| CPython 3.12.13 x64 | 已存在并执行成功；sqlite3 模块绑定 SQLite 3.53.1 | 推荐创建项目根 .venv 的基线 |
| PATH CPython 3.11.8 | 已存在；绑定 SQLite 3.43.1；本轮参考 DDL 在此解释器 :memory: 执行 | M0 检查工具；不静默作为 M1 的另一套运行环境 |
| uv 0.11.27 | 已存在且版本命令成功 | pyproject.toml + uv.lock，只操作项目 .venv；缓存使用项目目录 |
| Node 24.15.0 / npm 11.12.1 | 已存在且可执行；Node ABI 137 | 前端构建工具；package-lock.json 锁定前端依赖 |
| 项目 .venv / node_modules | 均不存在 | [FE-1总单](FULL_EXECUTION_BASELINE.zh-CN.md)整体确认后在M1建立，不复制其他项目环境 |

实际路径见 [仓库与环境事实](M0_REPOSITORY_FACTS.zh-CN.md)。不修改全局 Python、PATH 或 PowerShell Profile；启动器以项目 .venv 的真实解释器运行。macOS/Linux 重新创建自己的虚拟环境，不复制 Windows .venv。

## 后端候选清单

| 依赖 / 候选版本 | 官方 Python 条件或来源 | 作用与 M1 验证边界 |
|---|---|---|
| Flask 3.1.3 | >=3.9；[PyPI](https://pypi.org/project/Flask/) | HTTP Blueprint、app factory；不使用开发服务器作为交付运行入口 |
| python-socketio 5.16.4 | >=3.8；[PyPI](https://pypi.org/project/python-socketio/) | AsyncServer ASGI；握手、断连、HTTP/WS 升级实测 |
| python-engineio 4.13.5 | >=3.8；Socket.IO 当前要求 >=4.13.2；[PyPI](https://pypi.org/project/python-engineio/) | 传输层；作为解析依赖一起锁定和记录 |
| asgiref 3.12.1 | >=3.10；[PyPI](https://pypi.org/project/asgiref/) | WsgiToAsgi；前置请求体边界和 HTTP 调度必须实测 |
| Uvicorn 0.52.4 | >=3.10；[PyPI](https://pypi.org/project/uvicorn/) | 单进程 ASGI 服务器；默认 asyncio/h11，明确启用 WebSocket 协议 |
| websockets 17.1 | >=3.11；[PyPI](https://pypi.org/project/websockets/) | Uvicorn 的 WebSocket 实现候选；不能只装基础 Uvicorn 后假定 WS 已可用。具体协议选项在 M1 组合验证后固定 |
| sqlite3 标准库 | 跟随 Python 发行包；[Python 文档](https://docs.python.org/3/library/sqlite3.html) | 不另外 pip install sqlite3；记录实际 SQLite 版本和编译选项 |
| cachetools 7.1.8 | [官方文档](https://cachetools.readthedocs.io/) | 进程内 TTL/LRU 基础；主方案额外封装线程锁、条数/字节双限、单飞和回收 |
| portalocker 4.3 系列 | [官方文档](https://portalocker.readthedocs.io/) | 因本项目明确需要跨进程单实例保护而选用；OS 锁语义、异常退出和路径别名实测 |
| argon2-cffi 25.1.0 | >=3.8；[PyPI](https://pypi.org/project/argon2-cffi/) | M2 Argon2id；M1 提前确认 wheel、散列/核验、内存/并发预算 |
| Pillow 12.3.0 | >=3.10；[PyPI](https://pypi.org/project/pillow/) | M6 图片解码/重编码；M1 提前确认导入及基础编解码可用，完整安全策略 M6 验收 |
| Pydantic 2.13.5 | [PyPI](https://pypi.org/project/pydantic/) | 运行时输入 schema 和 JSON Schema 导出候选；pydantic-core 原生包需锁定并实装验证 |

Werkzeug、Jinja、h11、CFFI/Argon2 bindings、pydantic-core 等传递依赖由 uv.lock 统一固定。版本元数据存在不等于这整组已通过解析、安装、安全审计和应用测试；M1 若遇不兼容，应更新候选及证据，不能暗中降级安全能力或换后端框架。

## Flask 与 Socket.IO 组合依据

推荐入口为 Flask HTTP → WsgiToAsgi，加 python-socketio 的 ASGIApp，由 Uvicorn 承载；业务仍是 Python + Flask。该方案在三系统使用同一入口，减少依赖 Windows 不支持的部署组件。[Flask ASGI 部署](https://flask.palletsprojects.com/en/stable/deploying/asgi/)、[python-socketio ASGI 部署](https://python-socketio.readthedocs.io/en/latest/server.html#asgi)。

Python Socket.IO 5.x / Engine.IO 4.x 与 JavaScript Socket.IO 3.x–4.x 对应；前端候选 socket.io-client 4.8.3。协议版本匹配不能代替真实握手与重连验证。[官方兼容表](https://python-socketio.readthedocs.io/en/latest/intro.html#version-compatibility)。

Flask 不会因为套上 ASGI 就自动让阻塞任务变成异步。同步数据库/散列/图片工作必须有界；异步事件循环只管理传输和调度。[Flask async-await](https://flask.palletsprojects.com/en/stable/async-await/)。

本轮检查 asgiref 3.12.1 官方源码：先读取正文到 SpooledTemporaryFile，再调用 WSGI；run_wsgi_app 使用 sync_to_async 包装。由此推导 M1 必须验证前置限额、临时目录和线程敏感调度，不能只查看 Flask 配置就宣称资源受控。具体实现与并发效果仍未验证。[版本源码](https://raw.githubusercontent.com/django/asgiref/3.12.1/asgiref/wsgi.py)。

Flask-SocketIO 是可选的另一种集成路线，本期不同时混用两套 Socket.IO 封装；其不同服务器部署方式有不同 WebSocket/线程要求。gevent 的 Windows 支持为 Tier 2 / best-effort，因此不把它作为三系统统一基线。[Flask-SocketIO 部署](https://flask-socketio.readthedocs.io/en/latest/deployment.html)、[gevent 支持平台](https://www.gevent.org/install.html#supported-platforms)。

## 前端与开发工具

| 类别 | 候选 | 确认边界 |
|---|---|---|
| UI | React 19.3 系列、React DOM、TypeScript | 沿用已有视觉 token/布局；版本来自本轮官方研究，M1 锁补丁和 peer 依赖；[React 版本](https://react.dev/versions) |
| 构建 | Vite 8.2.2、React 插件 | 核对本机 Node 24.15.0 与最终插件 engines；M1 实际构建；[Vite 入门](https://vite.dev/guide/) |
| 传输 | socket.io-client 4.8.3 | 与 Python Socket.IO 5.x 对接；真实 ACK 来自应用事务；[客户端 API](https://socket.io/docs/v4/client-api/) |
| 离线 | IndexedDB；薄封装库按 M4 需要选择 | 原型 localStorage 不足以保存 Blob/原子 outbox；库版本在引入阶段核查 |
| 类型导出 | Pydantic JSON Schema → TypeScript 生成工具 | 生成器在 M1 选型/锁定；生成声明不替代后端运行时校验 |
| 定向检查 | pytest、Ruff、TypeScript、Vitest/Testing Library、浏览器测试工具 | M1 按实际文件配置并锁版本；本轮没有安装或运行这些产品测试 |

不为本期引入 Redis、Memcached、Celery、外部数据库或付费云服务。WebSocket、缓存与后台任务属于同一常驻进程；Docker 是后续可选交付形式，原生三系统运行不以 Docker/WSL 为前提。

用户新增明确的全站超管要求见 [后台范围](M0_SUPER_ADMIN_SCOPE.zh-CN.md)。M1需核查三系统进程/磁盘指标采集所需依赖；M2需核查超管第二因素与恢复的本地实现依赖；M7-Admin再按监控图表和管理交互选择前端组件。它们尚未选定版本或安装，不把当前候选表当作全部超管依赖已齐备，也不默认接入付费监控/身份平台。

## 跨系统安装和数据约束

| 平台 | 计划路径 | 本轮证据 |
|---|---|---|
| Windows x64 | 已安装 CPython 3.12.13 建根 .venv；优先兼容 wheel；PowerShell/CMD 入口复用真实启动链 | 仅已有解释器、磁盘和工具检查通过；没有新环境安装/HTTP/WS 运行 |
| macOS arm64 / x64 | 对应 CPython + 本机重建 .venv；验证 Pillow/Argon2/pydantic-core wheel 与实际 SQLite | 官方包提供安装路线；具体 OS 最低版本/架构组合未实机核验 |
| Linux x64 / arm64 | 对应 CPython/venv、平台 wheel；记录 glibc/musl 与发行版；脚本检测环境 | 没有 Linux 执行证据；不把 Windows 或 Docker 配置当作 Linux 验收 |

Pillow 与 Argon2 相关项目发布 Windows wheel，websockets 同时提供多平台和纯 Python wheel；但全部传递依赖及 macOS/Linux 架构组合仍须 M1 锁文件安装确认。缺 wheel 时先明确报告是否需要编译工具，不静默更换散列算法、跳过图像校验或安装系统级组件。

sqlite3 每线程/操作连接并保持 check_same_thread=True；本地 WAL/FULL/FK、短事务、有界写入和锁必须在磁盘数据库验证。WAL 不适合网络文件系统，多机不能共享同一个 SQLite 文件。[sqlite3.connect](https://docs.python.org/3/library/sqlite3.html#sqlite3.connect)、[SQLite WAL](https://www.sqlite.org/wal.html)。

cachetools 本身不线程安全，其 maxsize 也不会自动同时满足条数和字节两种上限；需要应用包装并测过期回收/并发/重启失效。portalocker 的职责是本地单实例锁，不将其宣传为多主机分布式锁。[cachetools](https://cachetools.readthedocs.io/)、[portalocker](https://portalocker.readthedocs.io/)。

M1 门槛：项目环境干净重建、依赖导入和核心原生功能、实际 Flask HTTP/Socket.IO WebSocket、磁盘 SQLite 重启持久化、缓存/锁并发、请求体限额、停止/恢复以及从项目外目录启动。三系统分别记录，缺平台保持未测；完整产品和验收后 Astra 体验测试见 [验收计划](VERIFICATION_PLAN.zh-CN.md)。
