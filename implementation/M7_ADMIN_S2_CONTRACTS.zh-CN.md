# M7 Admin S2 接口与界面合约

SA07–SA10；延续 S1 的当前超管认证、固定 operationId 预览/再认证/提交/任务结果。敏感读取 reason 通过 POST 请求体传递，不进 URL、浏览器存储或整段正文审计。列表页最多100条；精确 total 和查询有执行预算，超预算明确缩小筛选。普通成员 ACL 不变。

## SA07 消息治理
- POST /admin/content/search，body={reason,query?,senderId?,conversationId?,kind?:direct|group,status?:sent|recalled|moderated|purged,fromAt?,until?,after?,limit?}。返回 AdminPage<AdminMessage>；按 createdAt/id 倒序游标。正文敏感搜索词仅内存，安全筛选与详情ID可定位URL。
- POST /admin/content/<id>/read {reason} => {message:AdminMessage,items:AdminMessage[],hasBefore,hasAfter}；目标前后各25条，独立全站权限，不伪造成员身份。
- AdminMessage={id,conversationId,conversation:{id,title,kind,status},seq:string,sender:AdminIdentity|null,kind:user|system,text:string|null,status,moderationKind:null|hidden|deleted,createdAt,removedAt,removedReason,retained:boolean,canRestore:boolean,attachments:AdminFile[],replyToMessageId:string|null,reviewedAt,reviewedBy:AdminIdentity|null,version:number}。
- message.review / message.hide / message.delete / message.restore，parameters={}。review只记录审阅；hide/delete同样马上隐藏普通正文/文件，审计原因区分。restore只允许仍保留的管理处置；用户撤回或已物理清除绝不复原。改动发布 message.updated；搜索/引用/收藏/历史/离线补拉重新投影。
- 内容是否仍可读/恢复由当前保留期判断，即使后台清理还没运行也不能超期读取。不能把已清除的空正文算作保留。

## SA08 文件与空间
- POST /admin/files/search {reason,query?,ownerId?,conversationId?,state?,governance?:available|quarantined|revoked,kind?:image|file,fromAt?,until?,after?,limit?} => AdminPage<AdminFile>。
- POST /admin/files/<id>/read {reason} => {file:AdminFile}；POST /admin/files/<id>/content {reason,variant:content|preview|thumbnail} => 私有 no-store 二进制。每次重新认证/鉴权及审计；不返回公开链接或存储路径。UI 使用现有 API blob 核心封装，ObjectURL 只在内存，离开/换身份/关闭即撤销。
- AdminFile={id,name,owner:AdminIdentity,conversationId,messageId,purpose,kind,mime,size,sha256,state,scanStatus,governance,governanceReason,chargedBytes,createdAt,expiresAt,version,contentAvailable,previewAvailable,cleanupReason:string|null}。sha256为上传校验摘要，原件/预览是否存在均由实际文件检查；不暴露storageKey/lease。
- file.quarantine / file.release / file.revoke，parameters={}。独立治理覆盖层不改病毒扫描state/status；release绝不把infected/unknown/未就绪转成ready。受限文件普通全部下载/预览/头像/绑定入口拒绝；既有聊天附件展示不可用状态。
- user.quota {quotaBytes:number|null}，复用用户详情选择与命令预览；null回到站点默认，缩小只阻止新增，不删既有文件。
- 物理清理与受控导出由S3同一真实有界运维任务接入；S2不伪造已释放空间。

## SA09 举报工单
- GET /admin/reports?status=&category=&assigned=mine|unassigned|all&after=&limit= => AdminPage<AdminReportSummary>，列表不含举报说明/聊天正文。
- POST /admin/reports/<id>/read {reason} => {report:AdminReport,events:AdminReportEvent[],target:AdminMessage|AdminIdentity|AdminGroup|null}；消息目标独立审阅，关联证据保留当前实际状态，无虚构截图。
- Summary={id,reporter:AdminIdentity,targetKind,targetId,category,status,assignedTo:AdminIdentity|null,version,createdAt,updatedAt}；Report加description,feedback；Event={id,actor:AdminIdentity,action,reason,createdAt}，详情最近100步。
- report.claim、report.reopen parameters={}；report.reject {feedback:string}；report.resolve {feedback:string,disposition?:{action:user.ban|user.mute|conversation.freeze|message.hide|message.delete,targetId:string,until?:number}}。resolve每次只处理一工单；关联处置只允许本工单已知对象：消息本身/其发送者/其会话，举报账号本身，举报群本身。
- 关联处罚与工单状态/反馈/审计同事务，全成功才resolve；重复固定UUID不会重复处罚；预览同时指纹化关联目标，目标变动必须重新预览。处理、驳回、重开向举报者发站内通知及reports.updated；不向公众展示处置原因中敏感信息。

## SA10 站点策略
- GET /admin/settings => {version,values,fields:PolicyField[],appliedAt,effect:immediate,environment,readOnly:说明[]}。PolicyField={key,label,group,type:boolean|integer|string|enum,min?,max?,options?:{value,label}[],help}；界面按中文分区可编辑，不能以JSON编辑器代替管理页面。
- GET /admin/settings/versions?after=&limit= => AdminPage<{version,actor,reason,createdAt,values}>；历史分页并选择版本查看差异。
- settings.update {expectedVersion,values:完整可编辑字段映射}；settings.rollback {expectedVersion,version}，targetIds=[instance]。回滚创建新版本，按当前schema重新验证，不删版本；预览展现每项实际前后变化，旧版本冲突不消费再认证；最终显示运行版本。所有可编辑字段在请求/后续工作实际读取，部署密钥/路径/worker数只读需启动器改变。
- 首次从版本0修改时，事务内保存初始策略快照，版本历史可选择0回滚首次改动。初始记录时间表示保存快照的时刻。
- 基础现有字段：注册模式、群容量/自建群数、消息码点/字节/撤回秒、附件图片/文件/件数/总字节/用户配额/磁盘高水位、内容/审计/日志/事件/导出/注销保留、维护、运营信息/条款/站点名称。
- 补充实际生效字段：注册每小时/登录IP与账号15分钟/消息每分钟/建群每小时限流；上线提醒总开关。用户名/密码/CAPTCHA/再认证安全下限、客户端离线本机上限、部署扫描开关硬底线只读说明。
- production中不得从后台关闭严格扫描；open注册需运营信息预检通过；保留期缩小预览候选数量和后续清理影响；保存不立即删数据。已有会话有效期不追溯改写。
- GET /admin/site-invites?after=&limit= => AdminPage<{id,createdBy,createdAt,expiresAt,maxUses,used,revokedAt,status}>；site_invite.create {maxUses,expiresInHours} targetIds=[instance]；site_invite.revoke {} targetIds=[inviteId]。
- 新邀请码同S1秘密领取：操作完成后原管理会话5分钟内POST /commands/<id>/secret，只显示一次，DB仅HMAC摘要；AdminSecret新增kind区分manual_password_reset|site_invite并显示实际expiresAt。

## UI 与验收
4个真实新页面 /admin/content /admin/files /admin/reports /admin/settings。沿用灰蓝后台，支持筛选、分页、当前页明确批量选择、详情、空/错误/加载；读取提交前理由，翻页续用仅内存理由。中途降权清空敏感数据并取消请求。命令继续使用预览+密码/第二因素、未知结果找回固定UUID，部分完成按逐项状态展示。
根负责所有后端、迁移、核心DTO/API二进制封装与定向集成验证；UI仅分配admin页面/样式/定向UI测试。S3完成后再做完整后台及交付准备后的指定新Astra全功能测试。
