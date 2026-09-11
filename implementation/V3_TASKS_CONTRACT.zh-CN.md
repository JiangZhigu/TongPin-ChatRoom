# V3 实施契约（P0 + P1）

执行基准：用户已确认完整 P0/P1、V3-D01–D06 与手机四入口。P0/P1已实现并完成本机定向测试与第12轮联合浏览器检查，完整联合验收仍由M8承接。正式类型以 `apps/web/src/lib/tasks-types.ts` 为准，调用层为 `tasks-client.ts`。具体执行证据见[V3交付记录](V3_DELIVERY.zh-CN.md)。

## 界面入口与客户端

`TaskClient(userId, chatClient)` 使用现有 ChatClient 的引用型事件，不建立第二条 Socket。上层在账号生命周期中 start/stop；所有组件接收同一 client，用 useSyncExternalStore(client.subscribe, client.getSnapshot) 读取同一任务实体。页面查询结果使用 ID 映射最新 entities；invalid[id] 时隐藏旧正文或明确重新加载，不能继续操作。listRevision 触发当前查询重新加载，切换筛选/身份时取消或用请求序号丢弃旧结果。在线取决于现有聊天链路 online/degraded。

`TaskWorkspace` 建议 props `{ client, userId, conversations, contacts, initialGroupId?, initialTaskId?, onOpenSource, onClose? }`；可按实际组件拆分，但与聊天集成时统一。`TaskDetail`、`TaskForm`、`TaskShareDialog`、`TaskDrafts`、`TaskCardView` 等组件由 UI 负责，所有数据调用采用 TaskClient。聊天接入另列白名单，第一批不得修改现有壳层。

TaskClient 已提供 meta/list/get/create/patch/remove/restore/claim/release、检查项三方法、activities/comments/addComment/removeComment、reminder/mark、share/copyToGroup/card/report、preferences/saveLabel/removeLabel、groupSettings/changeGroupSettings、drafts/saveDraft/deleteDraft/reviewDraft。返回 DTO 的 capabilities 完全由服务端提供；不能只根据 creator/assignee/role 重新推断授权。实体缓存上限500，未知失效引用最多另保留500；实体移除时同时清理请求序号，不能无限增长。

创建、评论、分享与复制的 key 由表单生命周期保存（taskCommandKey），未知提交结果原样重试同一 key；更改载荷要换 key，创建成功与分享失败分开显示且只重试分享。条件写入携带真实 task.etag，412 后保留本地编辑并获取当前版本，展示差异，由本人确认再提交。禁止捕获412后自动覆盖。

## 页面功能

我的/个人/群/我创建/关注/收藏，未完成/三态/全部/回收；关键词、优先级、负责人、日期、个人清单/标签筛选，授权后计数与分页；列表和三列看板使用同一实体，按钮移动兼顾手机。创建/编辑标题1–120码点、描述4000码点/16KiB，纯文本、时区默认来自 meta.preferences.timezone；截止空值为 null。个人 assigneeId 始终本人；群普通成员只能本人或待认领，群管理员可选择其他当前成员（需加载完整分页成员，不用contacts冒充群成员）。检查项最多50，任务完成不自动勾选；有未完项须 confirmIncomplete=true 且先让用户确认。

详情包含任务属性、检查项、来源、活动、评论、到期提醒、关注/收藏、举报、删除恢复与共享。源消息不可用时不显示旧标识/正文；说明任务独立存在。群任务当前摘要/描述/检查项可被新成员读取，评论/活动只限本次加入后。禁言、维护与冻结时按 writeReason 显示禁用原因。

live 分享仅同群或当前同群好友私聊；snapshot 仅自己的个人任务，说明静态不联动，只选标题/日期/优先级及可选描述，不含原ID/来源/检查项/评论。副本存为个人待办走 create 的 snapshotMessageId，经本人确认创建新ID。个人复制到群需明确展示选中字段并勾选 acknowledgeShared（当前及未来成员可见），不自动移动原任务。

P1 包括通知四项偏好、个人清单和标签创建改名删除、群任务创建策略（members/managers）、任务/评论举报；运营扩展 UI 后续接入原后台，不暴露私人任务常规列表。TaskMeta 显示服务器开关，enhanced=false 隐藏P1入口，enabled=false保持聊天中性回退。

## 离线

只保存个人账号隔离的 create/edit 草稿，不加入聊天自动 outbox。7天后仍可查看/复制，不能直接提交过期草稿；重新确认创建新草稿。存储失败可见，不能提示已保存。联网调用 reviewDraft 复核身份、当前权限与版本，展示本机值/最新值后本人确认，再使用最新etag和新key；分享/认领/改派/删除绝不自动重放。退出时准确统计及按选择清理任务草稿，后续壳层接入。

## 传输与持久化

统一 `/api/v1/tasks`，现有 Cookie/CSRF/APIError 包络；所有任务请求加 X-Actor-Context，写命令加 Idempotency-Key，新任务实体修改加 If-Match。服务端先当前身份/权限，再 key 去重，最后新命令版本条件；读 DTO 的 etag 与 HTTP ETag 完全相同。UUID v4 key 用户级保存30天，仅存结果引用不存历史私密正文。

路径可由 tasks-client.ts 明确追溯；任务命令返回 `{task, duplicate}`，普通 GET task 返回 Task；分享返回 `{messageId, conversationId, duplicate}`。分页 `{items,nextCursor}`，任务列表额外 total/actorId。创建201/Location，删除为带当前回收DTO的200以便条件恢复；本工程不返回204空包络。API当前文档将在真实实现验证后合并。

迁移 0010 增量任务/检查项/活动/卡片/幂等/成员期水位/P1评论提醒偏好标签举报表。现有群退出、注销、保留清理及备份恢复在同一权限和事务机制中接入。功能开关关闭不删表，不回退旧迁移 checksum。

IndexedDB从版本1增量到版本2，新建taskDrafts对象仓库，与旧消息/草稿/租约并存；跨身份校验与清理在同一事务内完成。临时失效期间正文隐藏，但编辑器、评论输入和提交回执保持挂载；确认实体不存在、失权或身份变化才清理。任务和权限事件到达时，通知预览立即失效，旧分页响应不能恢复正文，随后读取服务器当前投影；举报反馈作为独立受控材料保留。

后台 `/admin/tasks` 提供按明确群范围和理由读取，以及按举报编号读取最小提交材料。删除、恢复、评论删除、群创建策略和举报处理均接入现有预览/二次验证/持久命令。私人待办没有全站常规列表、搜索和导出；聊天室已分享的静态副本仍作为聊天材料受审计读取。策略页提供有效个人/群配额，取部署硬上限与当前策略较小值。

隔离恢复重放当前任务删除、成员期水位、负责人、举报和提醒回执。备份后新建且被举报保留的对象只补不可恢复的最小占位；若其新群不在备份内而无法完整保留，则明确失败，不激活不完整恢复。后台恢复始终隔离演练，不替换正式数据库。
