# M7-Admin 第一批：监控与治理契约

基线：M7于`978bdd874a1973e8429e38e77da3148136a12d4b`关闭两项时序问题。完整SA01–SA14继续按FE-1实施。本批交付SA01–SA06与后续后台共用的预览、再认证、命令结果机制；SA07–SA14随后连续完成，不把本批称作完整后台。

## 管理边界

所有`/api/v1/admin`请求检查当前有效会话、当前站点super_admin角色和已完成第二因素验证。列表使用当前读事务；处置在取得写事务后重新检查。站点角色与群成员角色分开；列表只返回允许的元数据，内容审阅另用后续带原因的审阅接口。请求、任务和操作ID用于审计关联，不保存明文凭据或重复记录正文。

列表默认50、最大100条，排序和过滤白名单。游标为不透明值；时间窗口取1小时、24小时、7天。运行指标来自单进程当前运行期，十秒采样、最多720点；无样本显示未知。在线用户按实际连接去重，设备会话与连接分别计数。数据库业务统计可按窗口查询，不以窗口外历史填充进程采样。

## 通用处置

1. 页面选择明确目标并填写动作字段和3–500字理由，生成固定UUID `operationId`。`POST /admin/commands/preview`提交`{operationId,action,targetIds,parameters,reason}`；目标最多100个，返回准确目标列表、各目标版本指纹、匹配数量、影响说明、预览到期时间。
2. 本人通过既有`POST /auth/reauth`验证密码和动态码，action为`admin.execute:<operationId>`。令牌单次有效且绑定当前会话。
3. `POST /admin/commands/execute`提交`{operationId,reauthToken}`。重新检查预览、目标和权限；重复操作ID返回已保存结果，不重复处置。一个目标立即执行，多目标进入持久任务，每批最多10项，并在每项写入前检查操作者仍有权限。
4. `GET /admin/commands/<operationId>`查询准确结果：queued/running/completed/partial/failed/cancelled，total/succeeded/failed/pending和每目标结果。部分完成明确显示成功与失败，网络错误不等于服务器未执行；页面保留操作ID并提供核对结果。

预览过期或目标已变化返回可解释冲突，要求重新预览。批次中操作者降权、封禁、会话撤销或过期后停止未执行部分。已成功项不反向伪装为未执行。最后一个可用超管保护在真实事务中重新判断。

## 第一批接口与页面

统一成功外层仍为`{data,requestId}`，失败沿用`APIError`。

| 页面 | 接口 | 返回内容 |
|---|---|---|
| 概览 | GET `/admin/overview?window=24h` | window/from/to、生成时间、注册/活跃/在线/有效会话/连接/私聊/群/消息/上传/空间统计与下钻地址；实际每小时或每天业务趋势 |
| 运行监控 | GET `/admin/monitoring` | 最新样本与720点内样本、进程启动时间、磁盘/数据库/WAL/附件占用、HTTP/WS与数据库等待计数/延迟、任务状态计数、阈值、告警及恢复记录 |
| 用户 | GET `/admin/users?q=&status=&role=&sort=newest&after=&limit=50`、GET `/admin/users/<id>` | 资料/状态/限制、拥有群数、有效会话、实际存储和有效配额，不返回凭据；用户详情可定位URL |
| 会话 | GET `/admin/sessions?userId=&state=active&after=&limit=50`、GET `/admin/connections?userId=` | 会话设备、真实活动时间/期限/撤销状态和对应连接数；当前连接仅公开连接ID、用户ID、会话ID、连接时间 |
| 关系 | GET `/admin/relations?kind=friendship&query=&status=&after=&limit=50` | friendship/request/block/direct四类元数据；双方用户、状态、时间及私聊标识，不泄露消息正文或申请附言 |
| 群组 | GET `/admin/groups?q=&status=&ownerId=&after=&limit=50`、GET `/admin/groups/<id>` | 群资料、状态、群主与成员数/版本；详情含首批成员和分别分页的成员/邀请/申请 |
| 群子页 | GET `/admin/groups/<id>/members`、`/invites`、`/applications`，各支持after/limit | 当前真实成员期/角色/禁言；邀请用途、名额、使用、期限/撤销；申请状态与关联对象。无邀请原令牌或摘要密钥 |

列表的TypeScript响应模型由`apps/web/src/lib/admin-types.ts`约定。界面为独立后台导航，桌面侧栏、小屏可展开导航；设置/敏感操作表单不使用让用户输入JSON的技术表单。筛选与重要详情写入URL并可刷新恢复。长列表分页、明确空/忙/错误/失权状态，异步结果可持续核对。

## 第一批动作白名单

| action | targetIds与parameters | 行为 |
|---|---|---|
| user.ban / user.unban | 用户ID；空对象 | 封禁/解封，保存原因；封禁撤销所有旧会话与再认证，前台立即失效 |
| user.mute / user.unmute | 用户ID；mute为`{until}`，未来30天内时间戳 | 全站禁言或解除；HTTP与WS发送共享判断，展示原因 |
| user.restrict | 用户ID；`{uploadDisabled,groupCreationDisabled}` | 当前上传/建群入口重新检查限制；保留旧数据 |
| user.restore | 用户ID；空对象 | 只取消仍在冷静期内的注销；不恢复被撤销会话和退出的群 |
| user.password_reset | 单个用户ID；空对象 | 人工核验理由留审计，产生一次性密码重置凭据、撤销旧会话并要求改密；不越过超管第二因素 |
| session.revoke | 会话ID；空对象 | 撤销指定会话与对应连接 |
| user.logout_all | 用户ID；空对象 | 撤销该用户全部当前会话，含实时连接 |
| relationship.remove | friendship行ID；空对象 | 删除真实好友关系，更新私聊可写权限与双方上线提醒 |
| friend_request.cancel | 申请ID；空对象 | 撤销仍待处理申请，不伪造用户接受 |
| conversation.freeze / conversation.unfreeze | 私聊或群ID；空对象 | 冻结/恢复发送，不伪造双方私聊内容 |
| group.member.role | 当前成员期ID；`{role:'admin'|'member'}` | 更正管理员角色；群主由专用动作处理 |
| group.member.mute / group.member.unmute | 当前成员期ID；mute为`{until}` | 管理禁言与解除，更新写权限版本 |
| group.member.remove | 当前成员期ID；空对象 | 移除非群主并取消相关转让、终止当前可见期 |
| group.owner.change | 群ID；`{userId}` | 将群主纠正为本群当前活跃成员；核查拥有上限，原群主降普通成员，取消在途转让 |
| group.dissolve | 群ID；空对象 | 强制解散，关闭成员期、撤销邀请/保留名额、终止申请与转让，失权事件真实生效 |
| group.invite.revoke | 邀请ID；空对象 | 撤销邀请并释放对应待审预留名额 |
| monitoring.thresholds | `['instance']`；`{values:{...}}` | 校验运行阈值后写入新策略版本，不改启动密钥或进程路径 |

人工重置凭据在独立单次展示接口`POST /admin/commands/<id>/secret`读取，绑定执行者和同一管理会话，五分钟内一次性取出；不写入命令结果/日志。取出结果丢失时重新核验后另发一次凭据，旧凭据失效。普通恢复入口接受该一次性凭据并设置新密码；超管仍需要独立第二因素。完整管理员提权/因素恢复在SA12继续实施。

## 验证与边界

本批定向验证普通用户/群管理越权、迟到会话撤销、最后超管、预览与并发变化、幂等回执、部分成功和中途降权、HTTP/WS限制、邀请名额/成员期一致性、真实指标与告警恢复。采用隔离数据库、随机测试账号与真实启动；验证记录区分服务、传输、页面和受控故障证据。全量、负载、恢复及三平台验收属于M8/M9，最终新Astra完整体验只在交付准备完成后启动。
