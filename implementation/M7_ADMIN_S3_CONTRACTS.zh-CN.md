# M7-Admin S3：公告、安全、审计与运维接口约定

状态：已实现并完成本机定向检查，进入冻结审查。S2 已在 `4894103830a87d9d71a01fd966b525f75d453b10` 完成独立审查；S3实际证据与未验证边界见[阶段记录](M7_ADMIN_S3_DELIVERY.zh-CN.md)，不以接口描述替代M8验收。

所有管理接口均位于 `/api/v1/admin`，每次核实当前超级管理员和第二因素。写入使用现有 `commands/preview → auth/reauth(action=admin.execute:<operationId>) → commands/execute`，理由必填，固定操作 ID、目标版本检查和逐项结果沿用已有规则。`AdminPage<T>`、错误、游标和 Blob 处理沿用 S1/S2。下列时间均为毫秒时间戳。

## SA11：公告与系统通知

- 页面 `/admin/announcements`，GET `/announcements?status=&after=&limit=` 返回 `AdminPage<AdminAnnouncement>`；GET `/announcements/<id>` 返回单条完整管理记录。
- `announcement.create`，targetIds=`["instance"]`，parameters=`{kind:"announcement"|"notification",title,body,audience:"all"|"users"|"group",userIds:[],groupId:"",publishAt:null|时间戳}`。标题1–100、正文1–4000码点，指定用户最多100个；按提交时的有效账号/当前群成员形成最多10,000人的明确名单。预览显示匹配人数、计划时间、系统身份。定时范围为未来30天，立即发布使用 null。
- 创建成功表示已排入持久任务；页面显示真实计划/发送/完成/撤回/失败状态及 `deliveredCount/recipientCount`。每批最多100人，发起管理员被撤权、停用时终止未发送部分；正常退出登录不取消已授权的定时公告。撤回操作为 `announcement.withdraw`，targetIds=公告ID，parameters=`{}`；已收到的用户看到撤回提示，重新读取不返回旧正文。
- 普通通知新增 `system.notice`，以系统身份显示标题和正文，保留单独管理发起者；不插入普通用户聊天消息。GET `/api/v1/announcements/<id>` 只允许已发送名单中的本人读取，返回 `{id,kind,title,body,status,publishedAt}`；撤回后正文为空。普通通知页通过此接口打开详情，离开和身份变化清理详情、取消旧请求。

## SA12：管理员与第二因素

- 页面 `/admin/administrators`，GET `/administrators?after=&limit=` 返回 `{administrators:AdminPage<AdminAdministrator>,invitations:AdminAdminInvitation[]}`；邀请最多显示最近100条并明确边界。
- `administrator.invite`，targetIds=一个有效普通账号ID，parameters=`{}`，产生24小时内由本人完成的管理邀请。`administrator.cancel`，targetIds=邀请ID，parameters=`{}`。
- `administrator.revoke`，targetIds=账号ID，parameters=`{}`，撤销站点权限、第二因素与旧设备授权，保留普通账号；最后一个可用管理员受事务保护。停用账号复用 `user.ban`，详情/设备链接复用现有页。
- `administrator.factor_reset`，targetIds=另一个管理员账号，parameters=`{}`；人工核验理由必填，旧因素和全部设备失效，先降为普通账号并创建绑定邀请，完成绑定后才恢复站点权限。不能借此绕过最后管理员保护。
- 本人账号页 GET `/api/v1/account/admin-enrollment` 返回 `{invitation:null|{id,purpose,expiresAt,inviter}}`。POST 同路径 `/start`，body=`{reauthToken}`，该token对应 `administrator.enroll`；返回 `{enrollmentId,secret,uri,expiresAt}`。秘密仅当前页面内存显示，10分钟内验证，有效挑战再次开始会替换旧挑战。
- POST `/api/v1/account/admin-enrollment/finish`，body=`{enrollmentId,code}`，返回 `{user,recoveryCodes}`（独立第二因素恢复码8个）。验证真实TOTP后生效，当前已再认证并验证因素的会话保留，其他设备、旧再认证、旧第二因素恢复码失效。页面先让本人保存恢复码，再刷新用户和进入后台；重复完成不再次返回秘密。
- `scripts/manage.py recover-admin` 是停机后的本机交互恢复链：受实例锁保护、必填核验理由、确认已有管理员登录名、设置新密码和新TOTP并验证后提交，撤销旧授权并生成两套独立恢复码；无远程接口或默认秘密口令。

## SA13：审计与运行日志

- 页面 `/admin/audit`，审计 GET `/audit?actorId=&subjectId=&action=&result=&requestId=&jobId=&fromAt=&until=&after=&limit=`，返回 `AdminPage<AdminAuditEvent>`；运行日志 GET `/logs?level=&requestId=&jobId=&fromAt=&until=&after=&limit=` 返回 `AdminPage<AdminRuntimeLog>`。
- 审计含真实发起人、对象、理由、结果、时间和允许披露的前后差异/操作/请求/任务ID。没有改写或删除审计按钮。运行日志记录失败请求和任务/系统错误的脱敏类型、路由模板、状态及关联ID，不保存正文、查询参数、Cookie、密码或恢复码。
- 日志按30天及最多10,000条清理；审计按当前180天策略有界清理。尚未采集显示空状态与采集边界，不生成示例错误。
- 导出使用以下受控任务。审计过滤可以传给导出，但敏感理由和内容查询不写入URL或本机持久存储。

## SA14：运维任务、导出、备份与恢复演练

- 页面 `/admin/operations`。GET `/operations?kind=&status=&after=&limit=` 返回 `AdminPage<AdminOperation>`；GET `/operations/<id>` 返回单条；GET `/jobs?kind=&status=&after=&limit=` 返回 `AdminPage<AdminJob>`。运行中可见页面每5秒刷新、隐藏暂停、保留旧行与滚动，网络错误明确显示最后成功时间。
- `export.create`，targetIds=`["instance"]`，parameters=`{kind:"content"|"files"|"audit",filters:{...},maxRows,maxBytes,includeFiles}`。过滤字段见前端DTO。最多5000条、512MiB；预览显示匹配总数、选中数量、估计大小及固定目标摘要。超过预算明确拒绝，不静默漏文件。消息及其附件执行时重新核对当前保留和扫描规则。管理隔离不伪装成扫描通过。
- `backup.create`，targetIds=`["instance"]`，parameters=`{}`；完整SQLite快照与其私有文件一起打包，逐文件大小/SHA-256、数据库完整性和外键检查、应用/迁移版本与签名清单。密钥由部署者独立保管，不混入备份。默认上限10GiB/100,000文件，空间不足或范围超限明确失败；不创建部分成功备份。
- `backup.verify` / `backup.drill`，targetIds=已完成备份的操作ID，parameters=`{}`。verify核对清单签名、归档路径、大小/hash、数据库和迁移；drill另在本任务私有隔离目录恢复，使用当前实例权限/删除状态覆盖旧快照，重新执行到期规则、废止旧设备和在途管理授权，再检查数据库/文件。结果显示实际检查数、重放变化及隔离范围；不会替换正在运行的数据库。
- `storage.cleanup`，targetIds=`["instance"]`，parameters=`{}`；有界执行过期和孤儿文件清理、到期内容清理，报告实际删除文件数、释放字节、保留及备份占用原因。只能访问已验证的私有目录，不接受任意路径。
- `operation.cancel` / `operation.retry`，targetIds=任务ID，parameters=`{}`。取消协作式停止未完成步骤，已成功步骤保留记录；重试创建经当前操作者重新预览/再认证的新任务，不重复旧成功操作。任务最终状态由实际处理器写入，接受命令不表示备份/导出完成。
- `job.retry`，targetIds=可重试失败任务ID，parameters=`{}`；只允许已注册且可安全重试的后台处理器。治理命令失败需重新预览未完成目标；不可中断的系统步骤在UI显示具体限制，支持取消的管理任务由关联操作处理。
- POST `/operations/<id>/download`，body=`{reason,reauthToken?:string}` 返回带文件名的私有Blob。导出仅创建时的原管理会话可下载，24小时到期，权限撤销即时拒绝；备份下载另需 `backup.download:<id>` 再认证。所有下载留审计且 `no-store`，无公开链接。
- 每日自动完整备份，保留最近7份日备份及4份周备份；任务失败和完整性失败进入真实任务/监控记录。主机同盘备份不是独立故障域。启动后清除已崩溃进程的备份占用标记，保留可追溯失败/重试状态。
- 交付期另提供离线恢复到**新目录**的脚本，使用原密钥与有效权限/删除来源；无法取得当前权限状态时只允许隔离检查，不直接启用旧账号，避免悄然恢复已撤销访问。主机停机、替换目录和正式上线继续遵循FE-1部署边界。

字段精确定义位于 `apps/web/src/lib/admin-s3-types.ts`，界面不得把参数估计、已接受命令、扫描未知或隔离演练描述为完整处理成功/生产恢复。
