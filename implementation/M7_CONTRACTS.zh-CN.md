# M7 交互实现契约

执行范围来自FE-1与V2的M7。V3-POLICY待确认的任务/权限规则继续暂停；完整后台单独进入M7-Admin。M7-PRE在保留M6两份界面改动的情况下核对通过；M6最终修复已独立冻结并审查通过于bc4a8586。

## 表情和编辑器

固定Unicode Emoji 17.0 / Unicode 17.0.0、CLDR 48.2，官方源文件和hash在`vendor/unicode/17.0`，离线生成命令`python scripts/build_emoji.py`，`--check`只读校验。完整3944个fully-qualified序列都有中英文名称，2030个带肤色，最长10码点。表情模块在首次打开选择器时求值；离线服务工作线程会在后台预缓存包括该模块在内的构建资源，保证已缓存版本离线可用，并非承诺首次选择前不下载任何表情字节。`lib/emoji.ts`提供loadEmojiData/filterEmoji/emojiVariants/emojiKey/recentEmoji/rememberEmoji。最近24项按账号隔离，存储不可用不阻止插入。保留ZWJ/VS16、组合与肤色位置，只展示既有完整候选；不分发字体。界面支持分类/中英搜索/最近/键盘/肤色候选与光标处插入，并说明原生字形依赖系统。

Draft增加可选replyToMessageId、mentionedUserIds和mentionAll。只持久化引用ID，不将旧引用原文独立保存为永久副本。queue的相应选项会进入同一个消息和幂等标识；mentionAll缺省false兼容已有待发。当前群成员通过既有分页成员接口获取，所有提及由服务端再次核实；全体提及限当前群主/管理员。编辑器使用明确的引用/提醒对象条目，可移除；发送成功时只清除已提交条目，保留发送期间的新编辑。

## API（统一data/requestId外层）

| 请求 | data与行为 |
|---|---|
| GET `/api/v1/messages/:id` | `{message}`，当前可见消息，撤回等返回安全墓碑 |
| GET `/api/v1/messages/:id/context` | `{conversation,items,targetId,hasBefore,hasAfter}`，目标前后各最多25条，目标不可访问返回404 |
| GET `/api/v1/messages/search?q=&conversationId=&after=&limit=` | `MessageResults`，中文子串与转义LIKE；q为1–200字符、可选会话；keyset分页，最多100条，查询有时间/限流预算 |
| GET `/api/v1/bookmarks?after=&limit=` | `MessageResults`，仅本人；失权条目返回available=false和空message/conversation，不暴露旧正文，可移除 |
| PUT/DELETE `/api/v1/messages/:id/bookmark` `{}` | `{bookmarked}`，幂等；新增需当前可见的正常用户消息，移除本人的失权收藏仍允许 |
| PUT/DELETE `/api/v1/messages/:id/reactions/:emojiKey` `{}` | `{message}`，emojiKey为`lib/emoji.ts`的十六进制完整序列ID；幂等，必须仍可交互，拒绝禁言/屏蔽/失权；返回reactions.key是完整Unicode序列 |
| POST `/api/v1/messages/:id/recall` `{}` | `{message}`，本人两分钟内撤回，重复操作返回同一墓碑；正文/引用/附件立即不可见 |
| POST `/api/v1/messages/:id/moderate` `{reason}` | `{message}`，群主/管理员按目标角色判断；原因必填，管理删除和本人撤回分别记录 |
| GET/POST `/api/v1/conversations/:id/typing` | GET `{items:TypingUser[]}`；POST `{active:boolean}`返回`{expiresAt}`。不含正文，5秒TTL，客户端防抖；再次校验当前成员/写入权限，无持久输入记录 |
| PATCH `/api/v1/conversations/:id/preferences` | 增加`onlyMentions?:boolean`；与muted/pinned/archived相同的服务端持久化 |
| PATCH `/api/v1/friends/:id/preferences` | `notifyOnline?:boolean,remark?:string`，至少一项，备注最多80字且仅本人可见；返回`{notifyOnline,remark}` |
| GET/POST `/api/v1/reports` | GET本人ReportItem分页；POST `{clientReportId,targetKind,targetId,category,description}`，固定UUID重试、只提交一次，返回`{report,duplicate}`；category为spam/harassment/illegal/other，description最多1000字 |
| GET `/api/v1/account/deletion-preview` | `{coolingDays,ownedGroups,lastAdministrator,sharedMessagesRetained}`，真实影响与注销阻止原因 |
| POST `/api/v1/account/delete` | `{reauthToken,confirmation}`，reauth action=`account.delete`，confirmation必须为本人登录名；返回`{deleted:true,recoverBefore}`后会话即时撤销。UI说明恢复码与30天冷静期、群主先转让/解散、共享消息保留 |

`MessageResults.items`为`{id,available,message,conversation:{id,title,kind}|null,savedAt?}`，nextCursor为字符串或null。Message增加mentionAll/bookmarked及capabilities:{canInteract,canRecall,canModerate}；权限按钮使用实时结果，服务器始终复核。收藏/搜索/通知跳转由`ChatClient.jumpToMessage(id)`载入授权上下文并选择目标；UI显示目标定位而不是跳到最新消息。

## 同步、提醒和保留

提及通知以实体引用存库，失权或墓碑不再返回原文。免打扰和仅提醒提及影响即时提醒，站内未读继续保留。浏览器通知只能通过用户点击开启，拒绝/不支持/存储失败均有明确降级；页面关闭后的推送不作保证。系统通知使用通用正文，避免把消息明文显示在操作系统通知中。浏览器本地开关按账号隔离，既有全站doNotDisturb继续优先。

撤回/管理删除原文按FE-1保留30天用于受审计管理审阅；普通接口立即隐藏。到期任务有界清除正文、反应和可清理附件，保持消息id/seq墓碑。注销即时停用并撤销全部会话，恢复流程在冷静期内恢复；到期清除凭据和非必要资料，用户名保留，共享消息显示已注销身份。备份持有标记阻止不一致清理，空间以实际文件删除结果为准。

注销前页面保存草稿、暂停该客户端的同步和投递，再完成敏感验证与请求。网络结果未知时保留原body、验证凭据和本机处理选择；“核对注销结果”重复提交同一请求。服务器只允许原会话cookie与该次已消费`account.delete`凭据返回同一冷静期回执，不能用于其他访问或操作；回执保留至冷静期截止，恢复账号后立即失效。无法核对返回403 `DELETION_UNCONFIRMED`，本机内容保持不动。确认服务器成功后，本机清理失败只重试本机步骤。

清理任务每批最多100条撤回/删除内容、20个到期账号、总计20个群成员关系及每个账号50个待处理群申请；事件和审计各最多1000行。仍有积压时1秒后继续，正常每小时执行，启动时30秒内安排一次；备份期间延后。全部处理均使用当前持久化任务队列。消息定位与较新页加载若收到更晚的内容/权限变更则拒绝旧响应；上下文仍有后续页或正在切回最新历史时不发送已读游标。较新历史分页不计为实时新消息；“返回最新消息”成功完成历史加载与草稿恢复后明确滚到底，再按真实可见条件报告已读。离线、加载失败或中途选择其他会话不会误跳，普通会话选择继续恢复原阅读位置。

本页是实施契约，检查记录另存验证索引；未实现/未检查的条目不因出现在本页而视为交付通过。
