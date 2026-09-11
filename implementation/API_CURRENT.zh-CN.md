# 当前实现接口约定

这是前后端实施的接口依据，随批次更新。M2 已完成本批审查；M3/M4 接口见 [集成契约](M3_M4_CONTRACT.zh-CN.md)，M5 群聊、邀请和审批接口见 [M5契约](M5_CONTRACT.zh-CN.md)，M6 上传、文件、头像及本机Blob恢复见 [M6契约](M6_CONTRACT.zh-CN.md)，M7消息交互、引用与提及、搜索收藏、输入状态、举报、注销及保留见 [M7契约](M7_CONTRACTS.zh-CN.md)。接口文档不是运行通过结果。所有 JSON 成功返回 `{data: ..., requestId}`，失败返回 `{error:{code,message,fieldErrors?,retryAfterMs?},requestId}`。请求同源，Cookie 自动携带；POST/PATCH/DELETE/PUT 加 `X-CSRF-Token`，token 来自 bootstrap 或成功登录响应，仅存内存。密码、恢复码、验证码答案、会话凭据不能放 URL/localStorage/sessionStorage。未知字段拒绝。

## M2 账户

User: `{id,username,nickname,bio,avatarUrl:string|null,siteRole:'user'|'super_admin',status,createdAt,preferences:{invisible,readReceipts,doNotDisturb,...}}`。时间均为 Unix 毫秒；ID 为不透明字符串。

| 方法/路径（前缀 /api/v1） | 输入 | data 输出 |
|---|---|---|
| GET /auth/bootstrap | 无 | `{accountsEnabled:true,registrationMode:'closed'|'invite-only'|'open',csrfToken,user:User|null,terms:{version,operatorName,operatorContact,development,text}}`；设置匿名流程 Cookie 或读取当前会话 |
| GET /auth/captcha | 无 | `{captchaId,image:'data:image/png;base64,...',expiresAt}`；每次刷新废除本匿名流程旧图；答案不返回 |
| POST /auth/register | `{username,nickname,password,captchaId,captchaAnswer,termsVersion,acceptTerms:true,siteInvite?:string}` | `{user,csrfToken,recoveryCodes:string[],expiresAt}`；立即登录、恢复码只返回一次 |
| POST /auth/login | `{username,password,captchaId,captchaAnswer,remember:boolean,secondFactor?:string,admin?:boolean}` | `{user,csrfToken,expiresAt}`；超管需要 TOTP 或独立第二因素恢复码，缺少时 `SECOND_FACTOR_REQUIRED` |
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

条款必须展示服务器返回文本：超管可审阅私聊/群聊/附件且访问审计、保留与注销方式、恢复码丢失后没有自动找回。注册closed时登录/恢复仍可达；invite-only显示站点邀请码，不能用群邀请替代。

M7补充：`account.delete`再认证凭据通常按5分钟有效期消费；注销一经提交，仅原会话与该次已消费凭据可在冷静期内重取原注销回执，不因此恢复登录权限。恢复账号会立即废除该回执。其他请求在会话失效后仍按原鉴权拒绝，注销核对无法确认时返回403 `DELETION_UNCONFIRMED`，客户端保留本机处理选择与内容。

## M7-Admin 第一批

SA01–SA06概览、监控、用户、设备连接、关系、群治理及共用预览/再认证/幂等命令接口见 [S1契约](M7_ADMIN_S1_CONTRACTS.zh-CN.md)。所有管理请求重新验证当前有效会话、站点角色与第二因素；每个批量目标在写事务内再次验证权限和预览指纹。任务重试耗尽时，任务与未完成目标的失败结果在同一事务中提交，已成功目标仍明确保留。

`User`增加`restrictions:{uploadDisabled,groupCreationDisabled,reason,mutedUntil,muteReason}`。账号设置在打开、手动刷新和当前账号变更提示后读取`GET /auth/me`，不以旧bootstrap数据覆盖实时限制，也不覆盖正在编辑的个人资料。封禁在验证正确密码后返回`ACCOUNT_BANNED`及本人封禁理由；必须改密返回`PASSWORD_RESET_REQUIRED`，错误密码仍为统一登录失败。

人工重置凭据由同一管理会话在生成后5分钟内领取一次；凭据本身生成后1小时到期，恢复成功后失效。领取与有效期限分别显示。普通`POST /auth/recover`接受该凭据，超管恢复仍需独立第二因素；所有旧会话与旧重置凭据被撤销。
