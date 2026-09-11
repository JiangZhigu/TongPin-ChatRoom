# M8验收逐项证据映射

更新：2026-09-12。依据用户原始A01–G09及SA01–SA14，保留原设计文件不回写勾选。本表的“已覆盖”指对应自动化/阶段浏览器证据；最终冻结全量、三平台CI和UX-POST尚未完成的部分明确标注。阶段记录包含具体版本、测试ID、真实场景和局限，不能把测试文件存在当作运行通过。

共享证据索引保存在项目 `.codex/work-logs/tongpin-m0-20260911-01a08d87/verification-index.json`，本地原始数据不发布至GitHub。M8旧全量失败及之后定向修复见 [M8记录](M8_DELIVERY.zh-CN.md)，新的全量结果取得后补充。

## 原设计 A–G

| 条目 | 核对内容 | 现有证据与实际边界 |
|---|---|---|
| A01 | 注册、唯一性、昵称/长度 | [M2](M2_DELIVERY.zh-CN.md)真实注册；test_auth注册唯一/验证；最终全量待回填 |
| A02 | 服务端CAPTCHA及错误/过期 | M2浏览器及test_auth，生产响应不含答案 |
| A03 | CAPTCHA并发消费/轮换/重启 | test_auth的atomic_attempts_rotation_expiry_and_restart；M2错误后恢复界面 |
| A04 | Argon2id、盐、敏感信息 | M2凭据检查及test_auth；公开范围仍在发布时扫描 |
| A05 | Cookie/CSRF/旋转/限流/到期 | test_auth及M2真实HTTP/WS；HTTPS真实域名证书属于目标主机验收 |
| A06 | 恢复码一次性/并发/会话撤销 | M2及test_auth recovery_once_race；M7本机恢复流程 |
| A07 | 再认证与受控安全动作 | M2/M7及test_auth；无用户名自动重置入口 |
| A08 | 生产准入及群邀请分离 | test_auth invite_only、管理S2站点邀请，生产预检14项 |
| B01 | 好友申请完整流程/交叉幂等 | [M3/M4](M3_M4_DELIVERY.zh-CN.md)双浏览器；test_chat |
| B02 | 唯一DM及第三人拒绝 | test_chat并发/ACL，test_files附件ACL |
| B03 | 删好友旧历史/停发与屏蔽 | M3/M4浏览器、test_chat、test_interactions |
| B04 | 服务端身份/时间/角色 | 消息输入契约拒绝额外字段、actorContext绑定、系统消息服务端生成 |
| B05 | 两浏览器互发/刷新/重启 | M3/M4和M9两context浏览器；test_chat_live真实进程 |
| C01 | 创建者先入群/好友待确认 | [M5](M5_DELIVERY.zh-CN.md)三身份浏览器、test_groups |
| C02 | 群三级角色 | test_groups API权限及M5真实任免 |
| C03 | since_join及撤权覆盖全部读取 | M5/M6/M7/V3浏览器、test_groups/files/interactions |
| C04 | 再入不恢复旧成员期 | M5再入场景、test_groups/files，V3本次评论/活动水位 |
| C05 | 邀请预览/登录继续/隐私 | M5邀请生命周期浏览器与单元检查 |
| C06 | 邀请状态与旧管理页撤权 | test_groups及M5界面；M8补收件箱立即隐藏旧成员状态，最终体验复核待执行 |
| C07 | 最后名额竞争/审核预留/重启 | test_groups并发与持久检查，M5浏览器审核 |
| C08 | 禁言与草稿保留 | M5/M6/M7权限检查及真实草稿修复 |
| C09 | 群主转让/再认证/接受 | M5三账号转让及test_groups原子规则 |
| C10 | 解散/审计/访问撤销 | M5与管理S1；test_groups、test_admin |
| D01 | 提交后ACK/杀进程恢复 | test_chat_live真实WS及进程重启；M8 6005条一致 |
| D02 | HTTP/WS共享幂等及原编号重试 | test_chat/live、前端outbox、M8负载无重复 |
| D03 | 接收者离线补收/非已读 | M3/M4浏览器；M8全部100个接收者集合匹配 |
| D04 | 发送者断网刷新/存储失败 | M3/M4/M6真实浏览器；客户端IndexedDB直接检查 |
| D05 | 先权限同步再发旧队列 | M3/M4/M5/M6撤权；chat-client及outbox检查 |
| D06 | 换号隔离/多标签幂等 | M3/M4真实换号和双标签，V3草稿升级与身份检查 |
| D07 | 快照窗口/乱序/过期游标 | test_chat、chat-client；V3事件/草稿权威检查 |
| D08 | 多连接去重/最终离线 | test_chat及真实WS；M8 100连接；不承诺无网络时立即离线 |
| D09 | 提醒偏好/隐身/屏蔽 | test_chat/interactions/admin_s2和M7界面 |
| D10 | 前台阅读/多设备/关闭回执 | M7与V3遮挡已读浏览器、ReadVisibility单元 |
| D11 | 引用失权/撤回/管理审计 | M7/管理S2/V3真实联动；test_interactions |
| E01 | 真上传/下载/取消/重启字节 | [M6](M6_DELIVERY.zh-CN.md)双浏览器、test_files_live；M8 5件字节一致 |
| E02 | 数量/大小/配额/水位/chunked | test_files/file_validation/m1_transport和管理S2配额 |
| E03 | MIME/魔数/危险格式/路径/链接 | test_file_validation真实junction或symlink及文件字节 |
| E04 | 解码/像素/帧/EXIF/压缩包 | test_file_validation真实Pillow/归档字节；不自动解压用户包 |
| E05 | 私有附件及旧链接ACL | M6退出旧链接、M7撤回、管理S2隔离，test_files |
| E06 | 上传绑定/ready/取消/孤儿 | test_files、test_files_live及M6浏览器 |
| E07 | IndexedDB Blob刷新/配额恢复 | M6真实离线刷新重传与本机配额界面回归 |
| E08 | 扫描未知/失败不假报clean | test_file_validation环回扫描协议、test_files；本机无真实Clamd服务，生产一般文件保持隔离 |
| F01 | 浅灰浅蓝与布局基线 | M1–M7/V3阶段截图；最终Astra体验尚未执行 |
| F02 | 页面/弹层可达与操作 | 阶段浏览器覆盖各模块；完整独立体验逐入口待执行 |
| F03 | 长度/纯文本/IME/换行 | 输入与Composer单元、浏览器文字发送；物理中文候选确认未由自动化代表 |
| F04 | 草稿/滚动位置/分页锚点 | M3/M4/M6/M7浏览器与客户端单元，阶段缺陷已修复 |
| F05 | Unicode emoji/检索/肤色/最近 | M7浏览器、test_emoji、EmojiPicker；Unicode源/许可证随发布包 |
| F06 | 320–1920及手机导航/软键盘 | V3六种宽度及M9六截图无横向溢出；真实手机软键盘仍未测 |
| F07 | 弹层焦点/Escape/aria/缩放 | Modal/组件直接检查与阶段浏览器；屏幕阅读器和全站对比度审计未宣称完成 |
| F08 | 断线/失权/限流/失败真状态 | 各阶段真实故障路径和修复；最终体验复核文案 |
| F09 | 正式包无模拟认证/假ACK | 独立生产工程、M1–M7构建与源检查；发布范围扫描待最终冻结 |
| G01 | 三平台运行/构建/SQLite/上传 | 本机Windows已测；M9三标准runner CI配置待实际结果 |
| G02 | 缓存/持久规则/单实例 | test_infrastructure、test_m1_live真实第二实例与重启 |
| G03 | 限流/容量/DB忙/空间退化 | 有界执行器/上传/配额检查；M8-SQLITE-FAULT-01-01两项真实BUSY/FULL通过：消息/事件完全回滚，恢复后原编号唯一提交；不填满物理磁盘 |
| G04 | 100连接600秒实测 | M8-LOAD-COMPARE-01-01通过：6005/6005，p95 217.14ms；硬件/分位数/缺样与恢复时间见M8记录 |
| G05 | 一致备份/空目录恢复/撤权重放 | 管理S3真实备份/演练和test_admin_restore；V3任务/凭据当前权威重放 |
| G06 | 迁移/升级快照/代码回滚 | 基础迁移与部署单元通过；M9真实发布安装/升级/回滚演练待执行 |
| G07 | TLS/密钥/日志/监控/停机/jobs | 配置/日志/真实WS/任务恢复本机证据；TLS证书、反代端到端及目标主机托管待部署，不属默认上线授权 |
| G08 | 隐私/恢复/举报/注销保留告知 | M2/M7/管理S2/V3界面及生命周期测试，生产运营信息预检 |
| G09 | 三系统及Docker部署/环境/回退 | M9脚本和模板已实现；Windows入口实测；三平台CI和镜像内WS实测待回填 |

## 全站管理 SA01–SA14

| 条目 | 真实检查与当前边界 |
|---|---|
| SA01 概览 | [管理S1](M7_ADMIN_S1_DELIVERY.zh-CN.md)真实浏览器及test_admin聚合；M8实时负载样本 |
| SA02 监控告警 | S1告警/恢复，test_admin真实采样与监控故障；M8记录采集时间及一次缺样 |
| SA03 用户 | S1搜索/详情/封禁/禁言/人工恢复；test_admin事务/旧凭据/统一入口限制 |
| SA04 设备与连接 | S1真实强制下线/撤权，test_auth/test_admin及真实WS |
| SA05 关系 | S1跨用户关系处置及前台权限；test_admin关系限制，不冒充用户 |
| SA06 群治理 | S1跨群成员/角色/冻结/邀请处置；test_admin/test_groups保持成员期与预留一致 |
| SA07 内容 | [管理S2](M7_ADMIN_S2_DELIVERY.zh-CN.md)私聊/群聊审阅、删除/恢复及普通用户联动；S3真实导出 |
| SA08 文件 | S2受控下载、隔离/解除、配额；test_admin_s2与test_files保留独立扫描状态 |
| SA09 举报 | S2处理与本人反馈，V3具体任务/评论举报最小授权；幂等与联动回滚测试 |
| SA10 配置 | S2版本/预览/冲突/回滚/当前生效；test_admin_s2真实重启；M9运营信息离线审计 |
| SA11 公告 | [管理S3](M7_ADMIN_S3_DELIVERY.zh-CN.md)真实公告发送/撤回，test_admin_s3固定范围与部分失败 |
| SA12 管理身份 | M2/S1/S3两因素/受邀晋升/撤权/最后超管，主机受控恢复；无默认管理员 |
| SA13 审计日志 | S1–S3敏感读写理由、筛选/导出/脱敏，test_admin_s3真实失败请求日志 |
| SA14 运维任务 | S3真实异步导出/备份/预检/隔离演练；test_admin_operations/restore租约/取消/失败恢复；M9服务版本切换演练待执行 |

上述管理模块已经过各批冻结增量审查和缺陷关闭，后续共享Runtime变化必须由新全量承接。没有把普通群角色当作站点管理员，个人V3待办也没有普通全站检索入口。

## V3追加要求

F01–F27、E01–E07、D01–D06的完整实现和第12轮三会话联动见 [V3记录](V3_DELIVERY.zh-CN.md) 与 [接口/权限契约](V3_TASKS_CONTRACT.zh-CN.md)。核心、治理、聊天分享、当前权限恢复、提醒重启、DST/日期、配额、IndexedDB增量与手机四入口都有直接测试；个人静态分享不泄露原任务标识，群实时卡片按当前权限重新获取。

最后审查的草稿/来源预览问题已修复并复核；持续打开的群收件箱刷新也已在M8修复。最终体验仍须实际检查聊天与待办切换、旧草稿复核、当前来源失效、收件箱撤权即时刷新等用户可见路径。
