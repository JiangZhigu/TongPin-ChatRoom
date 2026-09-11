# M1 基础工程交付

状态：基础工程已实现，完成本机定向检查与实际浏览器检查；本地提交为78f23b44d0ce0f2c369d2d38396e7d622b1d80fc，已自动进入M2。不是完整聊天产品验收。

- Python 3.12.13 项目 .venv、SQLite 3.53.1、uv.lock 与前端 package-lock.json 已实际安装并校验；所有缓存和交付证据存放当前项目 .codex。
- Flask + python-socketio + Uvicorn 常驻单实例；真实 live/ready；每请求 ThreadSensitiveContext 与有界并发，SQLite 每操作连接与短写事务；WAL/FULL/FK/busy_timeout。
- 迁移 checksum 和事务回滚；私有数据目录、OS 单实例锁、有界 TTL/LRU 缓存及单飞加载、有界阻塞执行器、持久任务/租约/重试、指标采样。
- Flask adapter 前累计请求体限额、超时和并发；上传在第一次读取请求体前验证身份（M1 尚无账号，明确401），Engine.IO 独立限制帧/轮询大小。
- 保留浅灰浅蓝视觉的 React 前端、独立 /admin 未启用页、真实服务状态和失败重试、可访问模态与手机布局；开发空壳预览不进入生产构建。
- 根 npm setup/dev/build/start/check/test 经 scripts/run-python.mjs 调用项目 .venv；配置示例、生成的基础 JSON Schema/TypeScript，后续按业务扩充。

## 已执行验证

| 检查 | 实际结果 | 边界 |
|---|---|---|
| 环境 | uv锁一致/同步、npm ci、指定库导入、Argon2id散列验证、Pillow内存PNG通过 | 原生库样例不是安全策略全验收 |
| 后端 | 13项定向测试通过；Ruff检查通过 | 覆盖M1基础设施与传输；账号、消息和后台业务未实现 |
| 真实进程 | 实际HTTP ready、WebSocket 101与Engine.IO握手、M1应用认证拒绝；相同数据目录第二进程拒绝；重启可重新获取锁并使用数据库 | 不以M1拒绝认证冒充M2身份验证 |
| 启动路径 | 从 F:/py 调用根入口 --help 成功并使用项目解释器 | help检查只证明入口/路径；服务就绪另有真实进程证据 |
| 前端 | 6项单元测试、TypeScript检查、Vite生产构建通过；生产产物无DEV预览模块标记 | 局部mock只在测试；没有拿这些证明后端业务 |
| 浏览器 | agent-browser独立本机Chrome会话访问真实Flask构建；首页/管理入口真实显示；关于弹窗Escape关闭后焦点恢复；6种宽度无横向溢出；无初始页面/控制台错误；停止本任务服务后点击刷新，显示可重试连接失败 | 截图查看桌面和390宽手机；其余宽度为布局测量；非物理手机/真实输入法；不替代M8后指定Astra browser-use测试 |

源码对应 tests/test_infrastructure.py、test_m1_transport.py、test_m1_live.py；检查记录由本项目共享证据索引定位。第一次静态检查发现未用导入/样式问题，已修复；一次指定pytest临时目录的父目录缺失导致fixture失败，已把默认测试目录固定到项目.codex并补建父目录，后续13项通过。失败历史保留，不计作通过。

## 继续与剩余

按已确认FE-1自动进入M2，完成真实CAPTCHA、账号/会话/CSRF、恢复码、超管TOTP/初始化及审计；M1的accounts=false等未启用状态在对应实现后切换。三平台实测尚只有Windows，macOS/Linux在已授权免费CI中完成，不把依赖支持列表当作实测。

用户正式数据、原设计包59个保留文件和2项主动删除不变。没有配置生产密钥、付费资源或部署。重大事项见 [待确认清单](PENDING_CONFIRMATIONS.zh-CN.md)。
