# M5 群与邀请实现契约

执行依据为 FE-1 与 v2 的 C01–C10，不涉及待确认的V3待办规则。此文档为实现契约，结果在M5交付报告中另行记录。主智能体负责领域服务、迁移、鉴权与 `lib/`；UI子智能体只负责获分配的界面路径。

## 用户规则

创建者先成为唯一群主，选择的好友收到邀请，必须本人申请/接受后才可能加入。默认审核、24小时、10个名额；邀请码只保存摘要，创建时仅展示一次完整链接。GET预览不消耗名额，也不显示聊天、成员表或文件。链接使用 `/#invite=TOKEN`，页面立即移除地址片段，仅在内存保留；预览/申请通过 `X-Group-Invite` 请求头传入，不放URL、持久存储、分析或日志。匿名可预览，注册准入仍按站点规则，登录成功后仍需明确点申请。

每群默认200人、每账号最多20个当前拥有的群。pending同时预留邀请码名额和群容量，拒绝/取消/过期/撤销释放，批准在同一事务转为已用；所有判断使用当前权限。每次加入创建新的成员期，从本次加入后的消息开始可见；退出/踢出立即失权，再加入不恢复旧消息。邀请审批重试不能让已离开的成员重新入群。

群主可任免管理员、管理普通成员及管理员，管理员只能管理普通成员，不能管理自己或同级。管理员和群主可改群名、简介、公告、公告置顶、全员禁言和慢速模式；只有群主能改审核/邀请角色策略。群主不能直接退群，转让需再认证及当前成员接受，24小时过期，成功后原群主为普通成员。解散需再认证和明确确认，立即撤销访问，数据保留按FE-1执行。

## 前端类型与调用

类型以 `apps/web/src/lib/group-types.ts` 为准，调用现有 `api<T>()`。接口前缀均为 `/api/v1`，正常仍 `{data:...}`。GET列表返回 `{items,nextCursor}`，`after`/`limit` 与现有分页一致，最多100；必须提供可见加载更多与错误重试。

- `POST /groups` `{clientRequestId:UUIDv4,name,description,friendUserIds:string[]}` → `GroupDetail`。好友最多20个，不强行入群；成功后刷新ChatClient再选群。
- `GET /groups/:cid` → `GroupDetail`，含 `conversation,version,settings,capabilities,transfer`。成员身份只读；界面根据服务端能力显示操作，最终权限仍由服务端检查。
- `PATCH /groups/:cid` `{expectedVersion,name?,description?,announcement?,announcementPinned?,reviewRequired?,inviteRole?:'managers'|'members',everyoneMuted?,slowSeconds?}` → `GroupDetail`。慢速0–3600秒仅约束普通成员的新消息，重试原成功消息不触发慢速；禁止伪造成功。
- `GET /groups/:cid/members` → `Page<GroupMember>`；`GroupMember={user,periodId,role,joinedAt,mutedUntil}`。`PATCH /groups/:cid/members/:uid` `{expectedVersion,periodId,role?:'admin'|'member',mutedUntil?:number|null}` → `GroupDetail`；移出用 `POST .../:uid/remove {expectedVersion,periodId,reason}`。只有服务端允许的目标能操作，旧成员期不能作用于重新加入的同一用户。
- `POST /groups/:cid/leave {}` → `{left:true}`；`POST /groups/:cid/dissolve {expectedVersion,reauthToken}` → `{dissolved:true}`，随后刷新并清理选择。再认证使用现有 `/auth/reauth`，action=`group_dissolve:CID`。
- `GET /groups/:cid/audit` → `Page<GroupAudit>`，仅管理者；展示群操作，不显示站点级敏感日志。

邀请与审批：

- `POST /groups/:cid/invites` `{clientRequestId,kind:'link'|'direct',targetUserId?:string,maxUses:1..200,expiresHours:24|168}` → `{invite:GroupInvite,token:string|null}`。直接邀请必须是当前好友，限1个名额；链接token仅首次创建响应有值，重试同key时返回null并说明可撤销后新建，不能伪装已复制链接。
- `GET /groups/:cid/invites` 管理者/有创建权限成员查看自己可管的邀请；`POST /groups/:cid/invites/:iid/revoke {}` 撤销本人或管理者可管邀请。
- `GET /group-invites/preview`，调用 `api(path,{inviteToken:token})` → `InvitePreview`。状态包含 available/expired/revoked/exhausted/full/already_member/pending/unavailable。
- `POST /group-invites/:iid/apply {clientRequestId}`，链接附同一请求头，直接邀请无需头 → `GroupApplication`。返回pending明确待审核，approved且currentMember才可打开群；已是成员返回already_member，不消费名额。
- `GET /group-invites/mine` 显示给自己的直接邀请；`GET /group-applications/mine` 显示本人的申请历史。都必须从通知区域有可見入口，不能依赖聊天记录才找到邀请。
- `GET /groups/:cid/applications` 管理者待审核/历史列表；`POST /group-applications/:rid/approve|reject|cancel {}`。取消仅申请者；批准/拒绝检查当前群角色。返回当前 `GroupApplication`，明确已过期或已处理；处理后刷新通知和群详情。

转让：`POST /groups/:cid/transfers` `{clientRequestId,expectedVersion,targetUserId,targetPeriodId,reauthToken}`，action=`group_transfer:CID` → `GroupTransfer`；`POST /groups/:cid/transfers/:tid/accept|reject|cancel {}` → `GroupTransfer`。只有受让者可接受/拒绝，原群主可取消。当前群详情含尚有效的transfer，通知可打开群详情；接受完成前不在UI抢先改变群主。

## 界面接入

保留浅灰浅蓝聊天室结构。消息列表有“创建群聊”和“加入群聊”；群头详情改为可用群详情/成员/邀请/审批/公告/管理表单；通知显示直接邀请与申请状态；手机号/验证码及生产开关不新增。群头像在M6真实图片上传后接入，本批用已有首字头像。危险操作给可读后果、原因/再认证表单和真实返回结果，密码/第二因素只在表单内存，关闭清空。

退出/禁言/撤权保留草稿，失权后不展示旧历史。禁言或角色变化先使旧权限窗口失效，再自动加载仍获准的历史；迟到的旧成员期响应不能覆盖新窗口。已打开会话被移出或解散时，关闭详情、完成当前草稿保存后返回列表；保存失败保持编辑内容并提供明确重试入口。滚动位置的延迟保存绑定会话、正文、编辑版本和选择代际，不能在退出后用空正文覆盖旧草稿，也不能在发送后恢复旧草稿。

已经打开站点后收到同文档 `hashchange` 邀请也立即捕获、清除URL片段并打开预览，仍不自动申请。预览刷新采用当前成员状态更新提示；手动刷新群详情清除已经过时的操作提示。服务端 `VERSION_CONFLICT` 提示刷新，不自动用新版本重新提交管理动作。页面断网时不排队管理操作。所有新页面/弹层有键盘焦点、Escape和窄屏可达性；不能绕开此前的会话草稿、已读可见性和账号生命周期保护。
