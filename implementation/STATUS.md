# 同频实施状态

任务 ID：tongpin-m0-20260911-01a08d87。更新：2026-09-11。项目根：F:/py/demo_chatroom。

当前：**M1/M2 已完成本机定向验证、提交与本批审查；M3/M4 好友私聊和离线同步完成双浏览器实测及首轮独立审查，三项修复已通过定向测试，正在提交复核。V3 的 P0+P1 全范围已获确认并入本次交付，重要权限/保留规则待一次回复。** FE-1 持续执行，无逐阶段确认点。非常重要的新事项只暂停相关动作，写入[待确认清单](PENDING_CONFIRMATIONS.zh-CN.md)。

## 授权与固定范围

[FE-1 总单](FULL_EXECUTION_BASELINE.zh-CN.md)中的 C1/C2、完整 SA01–SA14 超管后台、私聊/群聊/附件审阅与审计、第二因素/恢复/保留/注销、公开代码推送及标准免费三平台 CI 均已获确认。后端 Python + Flask、SQLite、三平台进程内缓存与浅灰浅蓝界面继续执行，不采用 Vercel。

执行终点为完整开发与测试、M8 后新的同思考等级 Astra browser-use 全面体验测试、范围内修复复测，以及 M9 可部署版本交付。实际生产上线、付费资源、生产密钥配置与正式数据库清空不在默认范围内。

## 里程碑

| 阶段 | 状态 | 已执行范围与下一步 |
|---|---|---|
| M0 | 已验证 | 仓库事实、依赖官方核查、架构、完整需求及验收计划；FE-1 已整体确认 |
| M1 | 已验证 | .venv/锁定依赖、真实 Flask/ASGI/Socket.IO、SQLite/WAL/迁移/单实例、缓存/任务/指标、无模拟账户的 UI；13项后端、6项前端和真实浏览器定向检查；[阶段交付](M1_DELIVERY.zh-CN.md) |
| M2 | 已验证 | 账户、CAPTCHA、Cookie/CSRF、会话/再认证、TOTP超管身份和本地初始化；本机前后端与浏览器定向通过；独立审查发现并关闭身份失效UI、StrictMode bootstrap顺序两项问题，最终复核通过，见 [M2交付](M2_DELIVERY.zh-CN.md) |
| M3 | 冻结审查中 | 好友、唯一私聊、持久消息、HTTP/WS共用鉴权、提交后ACK；后端25项直接相关集成检查通过，双浏览器真实申请/接受/消息/屏蔽已验证，见 [M3/M4交付](M3_M4_DELIVERY.zh-CN.md) |
| M4 | 冻结审查中 | IndexedDB离线待发/草稿、接收者补收、游标/presence；13项核心模型检查、UI40项及修复7项通过；断网刷新、恢复发送、双标签与换号隔离真实验证 |
| M5 | 未开始 | 建群、邀请审核、角色、since_join权限、禁言/踢出/转让/解散 |
| M6 | 未开始 | 真上传、校验/配额/扫描策略、鉴权下载、持久附件和Blob离线恢复 |
| M7 / M7-Admin | 未开始 | emoji、引用/@/反应/撤回/收藏/搜索、通知与移动体验；独立完成SA01–SA14全站后台 |
| V3 P0 / P1 | G0差异完成，范围已确认 | F01–F27、E01–E07全部并入本次交付；待D01–D06新规则确认与M5/备份前置完成后连续实施，见 [V3差异](V3_G0_DIFF.zh-CN.md) |
| M8 | 未开始 | A–G及SA联合验收、故障/负载、备份恢复与三平台记录 |
| UX-POST | 未开始 | M8后另起同等级Astra，用browser-use测试聊天室与完整超管后台，修复并复测 |
| M9 交付准备 | 未开始 | 三系统/Docker部署脚本、发布预检、源码与发布包、升级/回滚演练及GitHub交付 |
| M9 实际上线 | 未开始 | 默认在本次授权范围外；不影响可部署交付 |

「已验证」仅覆盖对应行注明范围，不将设计原型、单元测试或HTTP状态等同完整产品验收。当前只有Windows本机实测；macOS/Linux和物理移动设备不能据此标通过。

## 版本与数据保护

- 公开目标：[JiangZhigu/TongPin-ChatRoom](https://github.com/JiangZhigu/TongPin-ChatRoom)。保留 main 初始化提交 4a195bc091429f6fc06cc79ce116117d53f4b1c0 和 Apache-2.0 LICENSE。
- M1 本地提交：78f23b44d0ce0f2c369d2d38396e7d622b1d80fc；M2 最终修复/冻结：bb4075d58bdb0482ae5f904c75b4aa6440032131；尚未推送。
- 用户原始61文件基线中59个保留文件未改，2个旧版文档为用户主动删除；原设计ZIP与完整原型目录不进入代码发布。
- 用户新增V3设计目录与ZIP保持原样，单独记录哈希基线并排除公开提交；不照搬参考SQL或原型假数据。
- .codex、.venv、node_modules、测试数据和本机配置均本地忽略；账户和浏览器验证使用项目内独立DATA_DIR与随机测试身份，不接触正式数据。

## 当前协作与证据

personal-subagents持续启用，standard；累计已使用docs-researcher、git-keeper、project-initializer、ui-engineer、code-reviewer五个实例，同角色复用。主智能体负责后端/核心逻辑、整合、日志和真实浏览器联调；全量回归与验收按实际风险派发。累计预算10个不同子智能体、最多3个子智能体并行、18轮实际浏览器；当前已用5轮（前2轮为GitHub连接失败，后3轮为M1/M2/M3-M4产品浏览器）。

[当前API约定](API_CURRENT.zh-CN.md) · [共享验证索引](../.codex/work-logs/tongpin-m0-20260911-01a08d87/verification-index.json) · [阶段记录](../.codex/work-logs/tongpin-m0-20260911-01a08d87/SUMMARY.md) · [验收计划](VERIFICATION_PLAN.zh-CN.md)。

早先Edge/内置浏览器的连接故障仍作为历史记录保留；当前本机agent-browser已完成M1/M2/M3-M4的真实Chrome检查。M8后用户指定的新的Astra browser-use步骤仍需按要求单独执行，不用早期检查抵扣。
