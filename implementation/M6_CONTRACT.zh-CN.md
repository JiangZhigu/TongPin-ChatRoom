# M6 真实图片、附件和本机恢复契约

执行范围为FE01/FE05和原E01–E08；M5复审已在59338f0关闭。主智能体负责后端、迁移、传输与前端lib；既有UI子智能体负责获分配的界面路径。原始设计包保持不变。

## 数据与安全边界

图片PNG/JPEG/WebP/GIF，单件10MiB；一般文件PDF/TXT/MD/CSV/JSON/DOCX/XLSX/PPTX/ZIP/7Z，单件25MiB；每条最多6件、总计50MiB；本人配额1GiB，磁盘高水位90%。名称仅用于显示和下载文件名，拒绝路径、控制字符与不受支持的扩展名；随机私有存储key与名称无关。

先以JSON申请上传记录，声明名称、大小、SHA256、用途、会话及当前访问标识。事务内检查当前账号/会话写权限、配额和磁盘预算并预留空间；实际原始请求体另行上传。上传前再次校验Cookie、Origin、CSRF、记录所有者及会话权限，接收过程中按实际累计字节限制，不信任Content-Length。二进制并发最多2，普通JSON请求保留独立可用能力。上传后重新计算大小和SHA256，使用临时文件和原子替换，记录与后台校验任务持久化。

服务端状态为reserved/uploading/processing/ready/quarantined/rejected/cancelled/expired，不能以计时器假装校验完成。只有ready可绑定消息；消息提交事务再次核对所有者、用途、会话、访问标识、数量、总量以及未绑定状态。已绑定附件不允许通过取消上传删除。未绑定上传24小时过期；取消/拒绝及崩溃残留由有界清理任务回收，已绑定有效消息的附件持续保存。重启后原申请可查询/重试，幂等键不对应不同字节。

原件与生成预览都在Web根目录外。消息原件始终鉴权下载且使用attachment/nosniff；预览仅提供服务端解码并重编码的安全图像。每次访问重新检查消息状态和当前成员期，失权、撤回、管理删除立即使旧链接失效。文件列表执行相同授权。头像只提供规范化后的图像，不公开原始EXIF图像；个人头像只对已登录账号可见，群头像只对当前可读成员可见。

## 校验与扫描

扩展名、浏览器MIME、魔数与实际解码应相符。Pillow先verify再重新打开，逐帧完成解码；限制单帧2000万像素、每边8192、最多200帧、累计4000万解码像素。EXIF方向规范化；消息预览最长边2560、缩略图320，头像512方形。动态图片提供明确标注的静态预览，原始动画可鉴权下载；不把默认呈现帧假称完整动画。

ZIP/OOXML只进行有界中央目录检查，不解压成员：目录元数据最多2MiB、成员最多2000、累计声明展开尺寸500MiB、压缩比上限100，拒绝路径穿越/加密ZIP/超预算与不匹配的OOXML结构名称。7Z只检查官方32字节头与有界下一头CRC/范围，不假称完成条目或压缩流验证。这些检查均不等同于恶意软件扫描。

Clamd适配器仅允许本机loopback，可选启用，不安装守护进程。实现真实PING健康与有界INSTREAM；只有明确单条OK才clean，FOUND拒绝，超时/错误/异常响应为unknown。生产一般文件缺扫描或扫描失败保持隔离。封闭本机测试须显式启用 `TONGPIN_ALLOW_UNSCANNED_FILES=1`，生产禁止此开关；界面和记录明确not_scanned。解码通过的图片可使用安全预览，不虚报病毒扫描通过。官方依据记录在项目证据目录的M6-DOCS-SCAN-01和M6-DOCS-CONTAINERS-01。

## API

使用现有 `/api/v1`、Cookie/CSRF、`{data:...}`、分页与错误结构。

- `GET /files/policy` → 单件/条数/总量/本人已用和预留配额、扫描策略、支持类型。
- `POST /attachment-uploads` `{clientUploadId:UUIDv4,actorContext,name,size,sha256,mime,purpose:'message'|'user_avatar'|'group_avatar',conversationId?:string,accessKey?:string}` → `UploadRecord`。同一账号/key+相同元数据返回原记录，不重复占空间；不同内容返回幂等冲突。
- `POST /attachments` 原始Blob请求体，`Content-Type: application/octet-stream`、`X-Upload-Id:ID` → 当前`UploadRecord`，完成接收后为processing，后台校验后查询真实结果。
- `GET /attachments/:id` → 当前可访问的`UploadRecord`；上传者可看本人的未绑定状态，但仍检查原会话权限。
- `POST /attachments/:id/cancel {}` → 当前状态；仅上传者且未绑定。`POST .../:id/retry {}` → 对仍有原件的隔离项重新安排校验，未知结果可查询原记录，不能伪造clean。
- `GET /attachments/:id/content` → 原件下载；`.../preview`、`.../thumbnail` → 服务端重编码图像。头像用途不提供原件下载。
- `GET /files?conversationId=&kind=image|file&after=&limit=` → 当前可读消息的附件列表；不通过全站附件表绕过聊天权限。
- `PUT /me/avatar {attachmentId:string|null}` → `{user:User}`；`PUT /groups/:cid/avatar {attachmentId:string|null,expectedVersion}` → GroupDetail。头像来自对应用途的本人ready上传；移除头像不影响消息附件。
- `GET /users/:uid/avatar`、`GET /groups/:cid/avatar` → 当前规范化头像；账号/群的状态和权限即时判断。普通头像URL没有公开永久凭证。

`UploadRecord`以lib/files-types.ts为准，含id、名称、大小、类型、用途、状态、扫描状态、错误、会话、时间和获准的预览/下载链接。Message.attachments使用真实元数据，并可含previewUrl、width/height、frameCount。用户/会话可含avatarUrl。所有链接失效都有可读错误，不能保留假下载成功提示。

## 本机队列与界面

选图、选择文件、粘贴及拖拽产生真实Blob，先写入本人IndexedDB草稿后显示保存完成；离线附件在草稿与队列合计最多50MiB。草稿与队列的附件转移在同一事务完成，保护换账号、其他标签及本机配额失败。发送仅在本机保存成功后清空编辑器，纯附件消息可发送。刷新后从Blob重建上传；未知上传结果查询/重试同一记录，已ready不重复上传。

ChatClient.queue的options新增files，saveDraft的position新增files；保持现有文字/引用/@接口。上传阶段显示本机准备/上传中/校验中/就绪/失败，取消停止本机上传请求并尝试取消未绑定服务端记录；失败保留Blob并可重试/复制回编辑器。按会话保序；某会话附件上传、扫描或失败不能阻塞其他会话的文字消息。禁止整站单条失败导致所有会话队列停止。

Composer提供可达选择按钮、拖拽/粘贴、附件条目移除及错误；聊天展示图片缩略图/大图弹层和文件卡片；文件导航页面展示真实可读列表与下载；设置和群管理提供头像选择/保存/移除。所有Blob URL只在组件生命周期内使用并释放，不持久化这些URL。离线恢复页显示保留附件并允许下载本机副本/删除/重新处理；退出、失权和账号切换沿用M5草稿保存保护，不用迟到定时器覆盖附件草稿。

实现后按E01–E08进行API、持久化/故障与本机浏览器验证，再交冻结审查。真实ClamAV尚未安装，不把受控协议测试当成真实签名扫描或生产开放验收。
