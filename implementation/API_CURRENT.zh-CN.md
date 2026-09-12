# 当前实现接口约定

这是前后端实施的接口依据，随批次更新。M2 已完成本批审查；M3/M4 接口见 [集成契约](M3_M4_CONTRACT.zh-CN.md)，M5 群聊、邀请和审批接口见 [M5契约](M5_CONTRACT.zh-CN.md)，M6 上传、文件、头像及本机Blob恢复见 [M6契约](M6_CONTRACT.zh-CN.md)，M7消息交互、引用与提及、搜索收藏、输入状态、举报、注销及保留见 [M7契约](M7_CONTRACTS.zh-CN.md)。接口文档不是运行通过结果。所有 JSON 成功返回 `{data: ..., requestId}`，失败返回 `{error:{code,message,fieldErrors?,retryAfterMs?},requestId}`。请求同源，Cookie 自动携带；POST/PATCH/DELETE/PUT 加 `X-CSRF-Token`，token 来自 bootstrap 或成功登录响应，仅存内存。密码、恢复码、验证码答案、会话凭据不能放 URL/localStorage/sessionStorage。未知字段拒绝。

## M2 账户

User: `{id,username,nickname,bio,avatarUrl:string|null,siteRole:'user'|'super_admin',status,createdAt,preferences:{invisible,readReceipts,doNotDisturb,...}}`。时间均为 Unix 毫秒；ID 为不透明字符串。

| 方法/路径（前缀 /api/v1） | 输入 | data 输出 |
|---|---|---|
| GET /auth/bootstrap | 无 | `{accountsEnabled:true,registrationMode:'closed'|'invite-only'|'open',csrfToken,user:User|null,terms:{version,operatorName,operatorContact,development,text}}`；设置匿名流程 Cookie 或读取当前会话 |
| GET /auth/captcha | 无 | `{captchaId,image:'data:image/png;base64,...',expiresAt}`；每次刷新废除本匿名流程旧图；答案不返回 |
| POST /auth/register | `{username,nickname,password,captchaId,captchaAnswer,termsVersion,acceptTerms:true,siteInvite?:string}` | `{user,csrfToken,recoveryCodes:string[],expiresAt}`；立即登录、恢复码只返回一次 |
| POST /auth/login | `{username,password,captchaId?:string,captchaAnswer?:string,remember?:boolean,secondFactor?:string,admin?:boolean}` | `{user,csrfToken,expiresAt}`；普通登录先不提交验证码，连续失败触发时返回 `LOGIN_CAPTCHA_REQUIRED`；超管仍需要 TOTP 或独立第二因素恢复码，缺少时 `SECOND_FACTOR_REQUIRED` |
| POST /auth/recover | `{username,recoveryCode,password,captchaId,captchaAnswer,secondFactor?:string}` | `{recovered:true}`；一组恢复码消费一次，撤销旧会话，不自动登录 |
| GET /auth/me | 无 | `{user,csrfToken,expiresAt}`，未登录401 |
| POST /auth/logout | `{}` | `{loggedOut:true}` |
| POST /auth/reauth | `{password,action,secondFactor?:string}` | `{reauthToken,expiresAt}`；5分钟、绑定当前会话+action、一次消费 |
| PATCH /account/profile | `{nickname,bio}` | `{user}` |
| PATCH /account/preferences | 允许字段 `invisible,readReceipts,doNotDisturb`（bool） | `{user}` |
| GET /account/sessions | 无 | `{items:[{id,device,createdAt,lastSeenAt,expiresAt,current}]}`；会话 id 不是凭据 |
| DELETE /account/sessions/:id | `{reauthToken}`，action=`revoke_session:<id>` | `{revoked:true}` |
| POST /account/password | `{password,reauthToken}`，action=`change_password` | `{changed:true}`；注销全部会话，返回登录界面 |
| POST /account/recovery-codes | `{reauthToken}`，action=`recovery_codes` | `{recoveryCodes:string[]}`；旧恢复码全失效，敏感令牌已消费 |
| GET /account/security-events | 无 | `{items:[{id,action,createdAt,device,result}]}`，最近50条 |
| GET /admin/auth | 无 | `{user,secondFactorRequired:true}`；验证当前已完成第二因素的超管会话，普通用户403 |

M2交付时启用了账户、安全设置和管理身份入口；目前聊天、群、文件与M7交互已接入真实服务。完整SA01–SA14后台业务仍由M7-Admin实现，不能以管理身份检查成功视为后台业务完成。

输入规则：username ASCII字母开头4–24位字母/数字/下划线，大小写唯一；昵称1–32码点无空白边缘或控制字符；bio0–200码点；密码15–128码点不 trim/截断，禁止控制字符和明显弱密码。验证码6位，不区分大小写，120秒最多5次，一次消费。错误字段映射用于表单，限流显示重试时间；失效图自动更新并保留非敏感输入，密码不写浏览器持久存储。

条款必须展示服务器返回文本：超管可审阅私聊/群聊/附件且访问审计、保留与注销方式、恢复码丢失后没有自动找回。新站默认open；后台显式保存的closed/invite-only/open继续生效。注册closed时登录/恢复仍可达；invite-only显示站点邀请码，不能用群邀请替代。

2026-09-12登录规则：按服务端来源IP与小写用户名组成的匿名摘要，在SQLite有界rate_buckets中记录连续凭据失败；不存在的用户名与错误密码采用相同计数规则。前4次失败返回LOGIN_FAILED，第5次失败开始返回401 LOGIN_CAPTCHA_REQUIRED。此后的请求缺少验证码时在密码验证前拒绝；错误/过期验证码返回CAPTCHA_INVALID，不增加密码失败次数。完整登录（含必要第二因素）成功时，在会话创建的同一事务中清零；最后一次密码失败15分钟后过期。固定64个锁槽串行同一来源/用户名的门槛检查与密码结果，防止并发请求同时越过第5次。验证码状态不依赖前端或匿名Cookie；原IP/用户名限流保留。注册和恢复接口的验证码字段仍强制必填。旧客户端主动附带验证码时仍验证并消费，不改变验证码单次消费语义。

M7补充：`account.delete`再认证凭据通常按5分钟有效期消费；注销一经提交，仅原会话与该次已消费凭据可在冷静期内重取原注销回执，不因此恢复登录权限。恢复账号会立即废除该回执。其他请求在会话失效后仍按原鉴权拒绝，注销核对无法确认时返回403 `DELETION_UNCONFIRMED`，客户端保留本机处理选择与内容。

## M7-Admin 第一批

SA01–SA06概览、监控、用户、设备连接、关系、群治理及共用预览/再认证/幂等命令接口见 [S1契约](M7_ADMIN_S1_CONTRACTS.zh-CN.md)。所有管理请求重新验证当前有效会话、站点角色与第二因素；每个批量目标在写事务内再次验证权限和预览指纹。任务重试耗尽时，任务与未完成目标的失败结果在同一事务中提交，已成功目标仍明确保留。

`User`增加`restrictions:{uploadDisabled,groupCreationDisabled,reason,mutedUntil,muteReason}`。账号设置在打开、手动刷新和当前账号变更提示后读取`GET /auth/me`，不以旧bootstrap数据覆盖实时限制，也不覆盖正在编辑的个人资料。封禁在验证正确密码后返回`ACCOUNT_BANNED`及本人封禁理由；必须改密返回`PASSWORD_RESET_REQUIRED`，错误密码仍为统一登录失败。

人工重置凭据由同一管理会话在生成后5分钟内领取一次；凭据本身生成后1小时到期，恢复成功后失效。领取与有效期限分别显示。普通`POST /auth/recover`接受该凭据，超管恢复仍需独立第二因素；所有旧会话与旧重置凭据被撤销。

## M7-Admin 第二批

SA07–SA10全站内容审阅、文件治理、举报处理、站点策略与邀请接口见[S2契约](M7_ADMIN_S2_CONTRACTS.zh-CN.md)。敏感搜索、上下文及文件读取均通过POST请求体传递理由，逐次核实当前超管与内容保留期限；私聊读取不依赖伪造群成员或好友身份。普通接口继续执行原有权限。

普通`Attachment`明确携带`state,errorCode,error`；管理隔离或撤销时返回`FILE_RESTRICTED`、空`contentUrl`，不提供预览URL。界面关闭已经打开的预览并取消下载；解除后只能使用当前的新读取结果。管理内容恢复同步修复当前及已缓存消息窗口的引用摘要，不把原消息插入有间隔的历史窗口。

站点策略首次从版本0修改时，在同一事务保存初始值，使历史页面可以回滚第一次变更。回滚创建新版本，保留审计及版本历史，并保留独立的监控阈值。站点邀请码同样采用原管理会话5分钟内单次领取，实际邀请码有效期单独显示。

## M7-Admin 第三批

SA11–SA14公告、本人管理员绑定、安全治理、审计/运行日志、受控导出、备份验证/隔离恢复及空间清理见[S3契约](M7_ADMIN_S3_CONTRACTS.zh-CN.md)。普通通知新增已送达对象可读的系统公告详情；撤回清空正文并推送更新。管理邀请只有本人密码再认证和真实TOTP绑定后才授予权限，恢复码仅一次显示。

运维任务拥有独立持久队列、进度、取消与最终结果；命令接受回执不代表产物完成。下载为带理由的鉴权POST；导出绑定创建会话且每次重查内容，备份下载另需行动绑定再认证。二进制请求允许最长600秒并可取消，JSON15秒和上传120秒时限保持各自规则。恢复结果必须明确`isolatedOnly=true`、`activationAllowed=false`，不会替换当前数据库。

## V3 待办 P0 / P1

正式DTO与输入见 `apps/web/src/lib/tasks-types.ts` / `src/tongpin/contracts/tasks.py`，集成与边界见[V3契约](V3_TASKS_CONTRACT.zh-CN.md)。下表前缀均为 `/api/v1`。普通任务请求携带 `X-Actor-Context`；服务端仍以当前Cookie会话决定身份。写命令使用UUID v4 `Idempotency-Key`，修改已有实体增加当前 `If-Match`。先核对当前身份/访问权限，再检查同key去重，最后对新命令比较版本；未知结果只能用原key和原载荷重试。

| 方法/路径 | 作用与data |
|---|---|
| GET /tasks/meta | 权威功能开关、本人偏好/清单标签、有效限额和创建能力 |
| GET /tasks | mine/personal/group/created/followed/bookmarked视图、群/状态/优先级/负责人/日期/关键词/清单/标签/回收筛选；`{items,total,actorId,nextCursor}`，授权后计数 |
| POST /tasks | 个人/群创建，可指定当前有权读的来源消息或已分享静态消息；201 `{task,duplicate}` 和Location |
| GET /tasks/:id | 当前Task DTO；HTTP ETag与DTO etag一致，private/no-store |
| PATCH /tasks/:id | 编辑、状态及分配，完成有未勾项时需explicit confirmIncomplete；返回`{task,duplicate}` |
| DELETE /tasks/:id | 软删除，返回当前回收DTO，HTTP200 |
| POST /tasks/:id/claim, /release, /restore | 认领、释放、恢复，条件写入，返回`{task,duplicate}` |
| POST /tasks/:id/check-items | 新检查项，最多50；返回当前任务 |
| PATCH / DELETE /tasks/:id/check-items/:itemId | 修改/勾选/删除检查项，按结构和进度能力分别鉴权 |
| GET /tasks/:id/activities, /comments | 当前加入期可读活动/评论分页 |
| POST /tasks/:id/comments | 提交纯文本评论，带命令key与当前任务版本 |
| DELETE /tasks/:id/comments/:commentId | 按本人或管理权限删除评论 |
| PUT /tasks/:id/my-reminder | 本人none/day_before/due_day规则及本地时间；不产生公共活动 |
| PATCH /tasks/:id/my-marks | 本人关注/收藏，不改变公共任务版本 |
| POST /tasks/:id/shares | 明确目标会话、live/snapshot、是否包含描述；201 `{messageId,conversationId,duplicate}` |
| POST /tasks/:id/group-copies | 本人个人任务复制到当前群，必须确认当前/未来成员可见，201新实体 |
| GET /tasks/cards/:messageId | 当前有权读的live任务、独立snapshot或unavailable；不返回失权历史正文 |
| PATCH /tasks/preferences | 本人分配/评论/完成/到期四项通知偏好及时区 |
| POST /tasks/labels; PATCH / DELETE /tasks/labels/:id | 本人list/tag创建/改名/删除；只组织本人私人任务 |
| GET / PATCH /tasks/groups/:groupId/settings | 当前群members/managers创建策略、计数、配额、etag与能力；修改需管理权限 |
| POST /tasks/:id/reports | 本人可访问的明确任务或评论提交最小举报材料，201回执 |

412不会自动覆盖：客户端保留本地输入，重新核对当前Task后由本人决定。任务事件只广播引用；临时失效立即隐藏旧实体和普通通知预览，迟到读取不能恢复撤权正文。静态副本不含原任务ID、检查项、评论或来源；用户明确选择描述时才包含描述。

管理员 `POST /admin/tasks/search` 要求明确群和读取理由，`POST /admin/tasks/:id/read` 再次按理由读取。`GET /admin/task-reports`只提供工单元信息；`POST /admin/task-reports/:id/read`读取具体提交材料。管理动作 `task.delete/task.restore/task.comment.delete/task.group.policy/task_report.close/task_report.reopen` 进入既有preview→reauth→command流程。不存在私人任务常规后台列表或批量导出。现有聊天审阅DTO补充 `taskCard`：已分享静态字段或群实时引用，不自动展开原任务正文。

任务草稿留在本机IndexedDB的独立taskDrafts仓库，不是自动同步服务端队列。任务提醒则使用服务端持久jobs与唯一回执；修改截止日/提醒、完成或失权会使旧工作失效，重启不会重复通知。
