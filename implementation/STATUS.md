# 同频实施状态

任务 ID：tongpin-m0-20260911-01a08d87。更新：2026-09-12。项目根：F:/py/demo_chatroom。

当前：**M1–M7、完整SA01–SA14及V3完整P0/P1已实现并完成阶段检查/审查修复。M8冻结全量Python212/212、Vitest435/435通过；600秒100连接负载6,005/6,005成功，p95 217.14ms，所有接收者补收/附件字节/数据库一致性通过。M9部署脚本、21项部署检查、真实完整安装/切换/回滚、安装隔离P1关闭、三平台CI及Docker实测均通过。交付说明冻结后生成本地UX前候选包；剩余必交步骤是新的同等级Astra完整体验及缺陷闭环，browser-use工具选择仍待回复。** FE-1持续执行，无逐阶段确认点。重大事项见[待确认清单](PENDING_CONFIRMATIONS.zh-CN.md)。

## 授权与固定范围

[FE-1 总单](FULL_EXECUTION_BASELINE.zh-CN.md)中的 C1/C2、完整 SA01–SA14 超管后台、私聊/群聊/附件审阅与审计、第二因素/恢复/保留/注销、公开代码推送及标准免费三平台 CI 均已获确认。后端 Python + Flask、SQLite、三平台进程内缓存与浅灰浅蓝界面继续执行，不采用 Vercel。

执行终点为完整开发与测试、M8验收、M9交付准备，然后在正式交付前才启动新的同思考等级Astra browser-use完整功能测试子代理，修复复测并更新交付物。这个时点已按用户2026-09-11追加要求更新。实际生产上线、付费资源、生产密钥配置与正式数据库清空不在默认范围内。

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
| UX-POST | 未开始，仅交付前执行 | M8和M9交付准备完成后、正式交付前才另起同等级Astra，用browser-use完整测试聊天室与超管后台，修复复测并更新交付物 |
| M9 实际上线 | 未开始 | 默认在本次授权范围外；不影响可部署交付 |

「已验证」仅覆盖对应行注明范围，不将设计原型、单元测试或HTTP状态等同完整产品验收。Windows本机与Windows/macOS/Ubuntu标准CI均有实际执行证据，具体环境见M9记录；没有以CI代替物理移动设备、其他Linux发行版或实际生产部署验收。

## 版本与数据保护

- 公开目标：[JiangZhigu/TongPin-ChatRoom](https://github.com/JiangZhigu/TongPin-ChatRoom)。保留 main 初始化提交 4a195bc091429f6fc06cc79ce116117d53f4b1c0 和 Apache-2.0 LICENSE。
- M1–M9保留完整递进历史。2026-09-11远端曾确认到4894103，该次同步操作者不作推断。2026-09-12主智能体在历史/增量公开范围审查后，按FE06授权分批快进推送至 `e3c066fa9b3617dfca9734e5f8f567e0463c0260`；[三平台CI第三轮](https://github.com/JiangZhigu/TongPin-ChatRoom/actions/runs/34637137650)四任务全部通过。之后仅交付Markdown说明更新，包内清单及外部交付回执保存最终文档提交SHA。
- 用户原始61文件基线中59个保留文件未改，2个旧版文档为用户主动删除；原设计ZIP与完整原型目录不进入代码发布。
- 用户新增V3设计目录与ZIP保持原样，单独记录哈希基线并排除公开提交；不照搬参考SQL或原型假数据。
- .codex、.venv、node_modules、测试数据和本机配置均本地忽略；账户和浏览器验证使用项目内独立DATA_DIR与随机测试身份，不接触正式数据。

## 当前协作与证据

personal-subagents持续启用，standard；已用9个不同子智能体（含M8专属Terra回归角色），第10个保留给最终新Astra体验。主智能体负责核心逻辑、整合、记录和真实环境检查。累计预算10个不同子智能体、最多3个并行、22轮浏览器；当前实际19轮：14轮本机、首轮CI Linux一轮、第二轮CI Windows一轮、第三轮三平台各一轮。无页面启动的准备失败复用预留；三平台不同环境和已定位失败的修复是预算更新依据，未重置累计计数。

[当前API约定](API_CURRENT.zh-CN.md) · [共享验证索引](../.codex/work-logs/tongpin-m0-20260911-01a08d87/verification-index.json) · [阶段记录](../.codex/work-logs/tongpin-m0-20260911-01a08d87/SUMMARY.md) · [验收计划](VERIFICATION_PLAN.zh-CN.md)。

早先Edge/内置浏览器的连接故障仍作为历史记录保留；当前本机agent-browser已完成M1/M2/M3-M4/M5/M6/M7的真实Chrome检查。用户指定的新Astra browser-use步骤仍需在交付准备完成后、正式交付前单独执行，不用早期检查抵扣。
