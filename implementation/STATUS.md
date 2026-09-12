# 同频实施状态

任务 ID：tongpin-m0-20260911-01a08d87。更新：2026-09-12。项目根：F:/py/demo_chatroom。

当前：**M1–M9、完整SA01–SA14及V3完整P0/P1的阶段实现、验收及交付准备已完成。开放注册、连续5次密码错误才要求验证码、新版UI及3项真实体验缺陷修复已整合；3项缺陷均有对应候选的真实Edge复测。完整体验仍在同一最终Astra中继续，未提前宣布正式交付。最新a0909d9三平台诊断CI四作业通过：三平台各497项前端，Windows121项后端，Ubuntu/macOS各118项及3项Windows专属跳过，真实浏览器与Docker通过。原bf4601b的两次HTTP500尚未定位，保留失败历史。系统Python自动引导已整合到5a9fe578并审查通过；其CI中Ubuntu/macOS/Docker通过，Windows因PowerShell5.1测试输出折行失败。该测试问题已定位、修正并审查。完整Edge体验又发现群主转让后旧管理弹层不更新，正在修复；下一轮统一验证。** FE-1持续执行，无逐阶段确认点。完整体验与版本边界见[UX记录](UX_REVIEW.zh-CN.md)，重大事项见[待确认清单](PENDING_CONFIRMATIONS.zh-CN.md)。

## 授权与固定范围

2026-09-12追加注册/登录变更：新站开放自主注册，保留后台三态开关与已存策略，增加`/register`直达；正常登录不取验证码，连续5次凭据失败才由服务端要求验证码，完整成功或15分钟无密码失败后解除。见[本批记录](REGISTRATION_LOGIN_DELIVERY.zh-CN.md)。原017332c候选保留为历史版本，本批完成后更新候选；最终Astra完整Edge体验已获授权。

[FE-1 总单](FULL_EXECUTION_BASELINE.zh-CN.md)中的 C1/C2、完整 SA01–SA14 超管后台、私聊/群聊/附件审阅与审计、第二因素/恢复/保留/注销、公开代码推送及标准免费三平台 CI 均已获确认。后端 Python + Flask、SQLite、三平台进程内缓存与浅灰浅蓝界面继续执行，不采用 Vercel。

执行终点为完整开发与测试、M8验收、M9交付准备，然后在正式交付前才启动新的同思考等级Astra，使用agent-browser驱动Edge进行完整页面交互测试，修复复测并更新交付物。时点按2026-09-11要求，工具按2026-09-12追加授权。实际生产上线、付费资源、生产密钥配置与正式数据库清空不在默认范围内。

## 里程碑

| 阶段 | 状态 | 已执行范围与下一步 |
|---|---|---|
| M0 | 已验证 | 仓库事实、依赖官方核查、架构、完整需求及验收计划；FE-1 已整体确认 |
| M1 | 已验证 | .venv/锁定依赖、真实 Flask/ASGI/Socket.IO、SQLite/WAL/迁移/单实例、缓存/任务/指标、无模拟账户的 UI；13项后端、6项前端和真实浏览器定向检查；[阶段交付](M1_DELIVERY.zh-CN.md) |
| M2 | 已验证 | 账户、CAPTCHA、Cookie/CSRF、会话/再认证、TOTP超管身份和本地初始化；本机前后端与浏览器定向通过；独立审查发现并关闭身份失效UI、StrictMode bootstrap顺序两项问题，最终复核通过，见 [M2交付](M2_DELIVERY.zh-CN.md) |
| M3 | 已验证 | 好友、唯一私聊、持久消息、HTTP/WS共用鉴权、提交后ACK；后端25项直接相关集成检查通过，双浏览器真实申请/接受/消息/屏蔽已验证；三项审查修复复核关闭，见 [M3/M4交付](M3_M4_DELIVERY.zh-CN.md) |
| M4 | 已验证 | IndexedDB离线待发/草稿、接收者补收、游标/presence；断网刷新、恢复发送、双标签与换号隔离真实验证；最后修复35项前端、2项后端定向通过 |
| M5 | 已验证 | 建群、邀请审核、角色、since_join权限、禁言/踢出/转让/解散；真实三账号群流程及草稿修复已复验；3项P2修复后17项群后端、42项相关邀请UI通过，并在59338f0复核关闭，见 [M5交付](M5_DELIVERY.zh-CN.md) |
| M6 | 已验证 | 附件专属35项后端/真实网络、核心30项、UI34项及后续7项通过；双Chrome实际上传/离线刷新与下载/重启/头像/退群旧文件失权验证。审查发现的草稿时序问题在bc4a8586复核关闭，见 [M6阶段记录](M6_DELIVERY.zh-CN.md) |
| M7 | 已验证及审查 | 完整emoji、引用/@/反应/撤回/收藏/搜索、通知、备注、本人举报、注销恢复与保留；第8轮双Chrome与迟到回执修复复审完成，见 [M7阶段记录](M7_DELIVERY.zh-CN.md) |
| M7-Admin | SA01–SA14已完成定向验证及复审 | 六个基础管理模块见[S1记录](M7_ADMIN_S1_DELIVERY.zh-CN.md)，S2已在4894103完成审查；S3在fae2709审出2项P2，补回归修复后于1fe4d28增量复核关闭，见[S3记录](M7_ADMIN_S3_DELIVERY.zh-CN.md) |
| V3 P0 / P1 | 定向验证及审查修复完成 | F01–F27、E01–E07、D01–D06及手机四入口；草稿/来源审查修复在219ab095关闭，见[V3交付](V3_DELIVERY.zh-CN.md) |
| M8 | 新冻结全量及600秒负载通过 | Python212/212、Vitest435/435；[联合回归/负载](M8_DELIVERY.zh-CN.md)、[A–G/SA逐项映射](M8_ACCEPTANCE.zh-CN.md)；真实SQLite BUSY/FULL故障恢复2项通过 |
| M9 交付准备 | 脚本/真实演练/增量复审/三平台CI通过 | 三平台各41项后端、435项前端及浏览器通过，Docker真实HTTP/WS通过；安装/配置/用户/管理员/运维文档齐全，冻结后生成UX前候选包；[M9记录](M9_DELIVERY.zh-CN.md) |
| 注册/登录追加 | 本机定向/浏览器/审查及三平台CI通过 | 68项不同后端用例有通过证据，35项UI及类型检查通过；真实注册/登录挑战与重置通过；新CI第三轮三平台各63后端/445前端及真实浏览器、Docker均通过，前两轮失败保留；见[批次记录](REGISTRATION_LOGIN_DELIVERY.zh-CN.md) |
| UX-POST | 同一最终Astra继续新版候选体验 | 使用agent-browser驱动Edge，从53b0afe经73快照继续到bf4601b，至少8个隔离身份覆盖聊天室、待办、账号与SA01–SA14；3项真实P2已修复并页面复测；第4项群管理远端状态刷新问题正在修复，剩余断言逐行记录于[UX记录](UX_REVIEW.zh-CN.md)，未提前记完整通过 |
| 自动安装器追加 | 已整合并审查，平台复验待完成 | 5a9fe578整合系统识别、缺Python包管理器引导及项目内3.12.13准备；复用另一任务117项安装/部署测试和Windows真实Python3.8至项目3.12.13安装/服务/页面证据，14文件与实际安装包匹配。原生无Python系统安装及Linux/macOS冷安装仍未验证 |
| M9 实际上线 | 未开始 | 默认在本次授权范围外；不影响可部署交付 |

「已验证」仅覆盖对应行注明范围，不将设计原型、单元测试或HTTP状态等同完整产品验收。Windows本机与Windows/macOS/Ubuntu标准CI均有实际执行证据，具体环境见M9记录；没有以CI代替物理移动设备、其他Linux发行版或实际生产部署验收。

## 版本与数据保护

- 公开目标：[JiangZhigu/TongPin-ChatRoom](https://github.com/JiangZhigu/TongPin-ChatRoom)。保留 main 初始化提交 4a195bc091429f6fc06cc79ce116117d53f4b1c0 和 Apache-2.0 LICENSE。
- M1–M9保留完整递进历史。2026-09-11远端曾确认到4894103，该次同步操作者不作推断。2026-09-12主智能体在历史/增量公开范围审查后，按FE06授权分批快进推送至 `e3c066fa9b3617dfca9734e5f8f567e0463c0260`；[三平台CI第三轮](https://github.com/JiangZhigu/TongPin-ChatRoom/actions/runs/34637137650)四任务全部通过。之后仅交付Markdown说明更新，包内清单及外部交付回执保存最终文档提交SHA。
- 注册/登录追加阶段曾推送至 `53b0afe7dfedfcbf1ce74dfea480e81f56999f35`；[该阶段三平台CI](https://github.com/JiangZhigu/TongPin-ChatRoom/actions/runs/34672494067)四任务全部通过。首次完整体验候选为357文件的 `dist/releases/tongpin-0.1.0-edge-ux-candidate.zip`，清单和构建回执已校验；此后UI整合、体验修复和安装器提交及候选见[UX记录](UX_REVIEW.zh-CN.md)。历史包和日志继续保留。
- 用户原始61文件基线中59个保留文件未改，2个旧版文档为用户主动删除；原设计ZIP与完整原型目录不进入代码发布。
- 用户新增V3设计目录与ZIP保持原样，单独记录哈希基线并排除公开提交；不照搬参考SQL或原型假数据。
- .codex、.venv、node_modules、测试数据和本机配置均本地忽略；账户和浏览器验证使用项目内独立DATA_DIR与随机测试身份，不接触正式数据。

## 当前协作与证据

personal-subagents持续启用，standard；累计13个不同子智能体含历史9个、注册批次Git/UI/审查3个及最终新Astra1个，最多3个同时执行子任务。主智能体负责核心逻辑、整合、记录和真实环境检查。截至5a9fe578安装器CI完成，本任务已累计41个实际浏览器环境执行，当前预算43；Windows该轮未到浏览器阶段，已释放未使用的预留次数。同一版本的连续页面操作不逐次计轮。历史失败、用户暂停后的新UI复验及三平台环境均保留累计记录，不因换阶段清零。后续确需新环境执行时先登记原因和额度。

[当前API约定](API_CURRENT.zh-CN.md) · [共享验证索引](../.codex/work-logs/tongpin-m0-20260911-01a08d87/verification-index.json) · [阶段记录](../.codex/work-logs/tongpin-m0-20260911-01a08d87/SUMMARY.md) · [验收计划](VERIFICATION_PLAN.zh-CN.md)。

早先Edge/内置浏览器的连接故障保留为历史记录。本机阶段验证使用真实Chrome；用户2026-09-12已允许最终新Astra改用agent-browser（Edge），该完整体验在交付前单独执行，不用早期定向检查抵扣。
