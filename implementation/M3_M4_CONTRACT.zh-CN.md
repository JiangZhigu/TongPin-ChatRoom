# M3/M4 集成契约

本批实现好友、唯一私聊、消息持久化、双向离线补收及多标签页协调。群业务 M5、附件 M6、完整消息工具及管理业务 M7 后续接入；此文档是接口约定，不是已验收声明。最终规则仍以 FE-1 和完整验收清单为准。

本批实现与定向运行证据见 [M3/M4 交付记录](M3_M4_DELIVERY.zh-CN.md)。

## 前端唯一核心接口

类型在 `apps/web/src/lib/chat-types.ts`，网络使用既有 `api`。主智能体负责 `lib/chat-client.ts`、`lib/outbox.ts`、服务工作线程和所有后端；UI 只消费这些接口。

`new ChatClient(user)`：user 为登录后真实 User。`subscribe(listener)` 返回取消函数；`getSnapshot()` 返回稳定 ChatState；`start()`/`stop()` 支持 StrictMode 重建并清理连接、计时器与监听。选中会话只保存于当前页面 UI；服务器历史不写入浏览器永久缓存。

- `selectConversation(id: string | null): Promise<void>`、`loadOlder(): Promise<void>`。
- `queue(conversationId, text, options?: {replyToMessageId?:string; mentionedUserIds?:string[]}): Promise<void>`：IndexedDB 事务完成后才 resolve。UI 只在 resolve 后清空发送时的正文；若期间继续编辑，不能把新文本清空。发送中状态指本机保存/投递状态，服务端 ACK 表示已保存，只有真实 peerReadSeq 才表示已读。
- `retry(clientMessageId): Promise<void>`：同一 ID/同一内容重试；权限期改变、过期或幂等冲突不自动改 ID，可复制回编辑器后由用户新发。
- `cancel(clientMessageId): Promise<void>`：停止本机重试；不能表述为撤回已到达服务器的消息。
- `loadMoreConversations/Contacts/Requests/Notifications(): Promise<void>`；`refresh(): Promise<void>` 重新同步权限。
- `read(conversationId, seq): Promise<void>`：UI 仅在页面可见、聚焦、该会话显示且确实看到了底部消息时调用；上翻历史或隐藏标签页不报读。
- `getDraft(conversationId): Promise<Draft|null>`、`saveDraft(conversationId,text,position?:{scrollTop?:number;anchorId?:string}): Promise<void>`。UI 显示本机保存失败；切会话前等待当前草稿保存，避免旧响应覆盖新会话。
- `getLocalSummary(): Promise<{pending:number;drafts:number}>`；`logout(choice:'keep'|'delete'): Promise<void>` 在停止队列后执行真实退出，并按选择保留/删除该账号本机待发和草稿；清理活动账号标记。存在本机内容时，UI 显式询问“保留待下次登录继续”或“删除本机内容”，允许取消退出。

好友 UI 调用真实 REST 后 `client.refresh()`：用户搜索 `GET /users/search?q=...&after=...`；好友 `/friends`；申请 `/friend-requests`（POST targetUserId/note）及 `/:id/accept|reject|cancel`；删除好友 `DELETE /friends/:id`；屏蔽 `/blocks/:id`（PUT/DELETE 空对象）和 `/blocks` 列表；逐好友提醒 `PATCH /friends/:id/preferences {notifyOnline}`；建立私聊 `POST /conversations/direct {friendUserId}`。会话 `/conversations/:id/preferences` PATCH muted/pinned/archived；通知 `/notifications/:id/read` POST 空对象。

`accessKey` 是发送时绑定的权限期，并非登录凭据。好友关系删除重建、屏蔽变化或群加入期/发送权限变化会使旧待发内容停止自动发送。它在服务端重新核验，不能代替 Cookie、CSRF 和当前关系检查。

发送字段 `actorContext` 绑定开始编辑/排队的账号，服务端只将它与当前已鉴权身份比较，不从请求中决定发送者。它阻止其他标签换号后把旧账号排队内容当作新账号发送。

## 数据与同步

HTTP `/conversations/:id/messages` 与 Socket.IO `message.send` 调用同一领域服务。HTTP 输入是 SendPayload；WS 多出 `v:1,conversationId,requestId`，成功 `{ok:true,requestId,data:SendResult}`；失败 `{ok:false,requestId,error}`。不能提交 senderId、createdAt、seq 或角色。UUID v4 clientMessageId 在重试时保持不变；payload 变化返回 409。

历史页返回 `items,nextCursor,hasMore,lastSeq,accessKey`；序号及游标为十进制字符串。页面合并前需核对响应权限期与当前会话；晚返回的历史不能覆盖请求期间的新事件、提交结果或撤回占位。旧窗口与新页不连续时保留连续尾部，提供向前补拉，不能假装中间没有消息。

快照 `/sync/snapshot` 的首批好友、会话、申请及 cursor 来自同一 SQLite 读事务；分页显示明确“加载更多”。会话按更新时间及 ID 游标分页；已发出的增量事件负责补充快照窗口内移位/新增会话。增量 `/sync?after=...&limit=100` 只读当前账号引用并再次物化权限；应用成功后才推进游标，410 时重做快照并保留本机队列。后台 durable job 仅发送 `sync.available` 提示，真实消息和权限始终从已提交数据物化。

实时连接打开后再做快照/补拉；连接掉线时使用 HTTP 同步并明确降级状态。重连每次获取新的单次 WS ticket。在线数按用户多个连接聚合；最后连接断开后防抖，好友提醒默认关闭，隐身/屏蔽/非好友不会收到上线提醒。好友上线提醒是当前连接内短暂提示，不向离线接收者补发“最近上线时间”。

队列最多100条、7天；Blob总计50MiB（附件在M6启用）。Web Locks存在时持有同账号独占锁；否则IndexedDB租约+心跳；两种路径均由服务器幂等兜底。IndexedDB以事务complete为保存成功边界，不能用单个put请求成功冒充整个事务提交。密码/会话凭据不进入IndexedDB、localStorage或sessionStorage。

生产构建的 service worker 只缓存本站 HTML 与带构建哈希的静态资源，不缓存 API、聊天历史、管理页响应或认证信息。断网刷新显示明确的本机离线恢复页面，仅按当前本机身份标记与 revision 展示待发和草稿；它不是服务器认证证明。没有有效标记时不展示其他遗留账号内容；恢复网络后重新验证身份再进入聊天。

## 官方依据（2026-09-11核查）

- [Socket.IO 交付保证](https://socket.io/docs/v4/delivery-guarantees/)：默认连接恢复不足以保存刷新前待发或补发服务端漏收事件，需要应用层持久化。
- [IndexedDB 事务完成](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction/complete_event)：事务成功提交后才发出 complete。
- [Web Locks request](https://developer.mozilla.org/en-US/docs/Web/API/LockManager/request)：独占锁随异步回调结束释放，未获锁不得同时投递。
