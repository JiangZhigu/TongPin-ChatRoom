# 同频 · TongPin ChatRoom

同频是可以自行托管的聊天与待办应用，采用 Python 3.12 + Flask、Socket.IO、SQLite 和 React。账号、好友私聊、群聊、离线待发、图片文件、消息互动、个人/群待办，以及全站超级管理员后台均已接入真实持久化服务。交付进度、测试缺口与版本见 [STATUS](implementation/STATUS.md)；开发环境不代表已公开运营。

## 本地运行

准备 Python **3.12.13**、uv **0.11.27**；从源码构建还需要 Node.js **24.15.0或更高的24.x**、npm **11.12.1或更高的11.x**。安装限定在项目虚拟环境、Node依赖和缓存，数据保留在专用目录。

Windows PowerShell：

```powershell
.\tongpin.cmd doctor
.\tongpin.cmd install --dev --build
.\tongpin.cmd manage init-admin
.\tongpin.cmd run
```

macOS / Linux：

```sh
sh ./tongpin.sh doctor
sh ./tongpin.sh install --dev --build
sh ./tongpin.sh manage init-admin
sh ./tongpin.sh run
```

首位超管通过本地主机交互式命令创建，没有默认账号或密码。初始化要求添加验证器并输入有效动态码，随后只显示一次两套恢复码。启动后打开 [本机入口](http://127.0.0.1:8765)，全站管理入口为 `/admin`。注册默认关闭，超管可配置邀请注册。正常停止按Ctrl+C并等待完成。

发布ZIP自带前端时可使用 `install` 省去Node构建。`install --download-python` 允许uv把锁定Python下载到项目内，但仍需已有Python3.12+与uv启动安装入口。脚本从自身目录定位项目，不依赖调用者当前目录。

配置可通过环境变量或根 .env 提供，示例见 [.env.example](.env.example)。项目内启动桥接优先使用根 .venv，从其他工作目录调用脚本时仍以项目根解析数据和资源。

## 主要功能

- 账号与安全：验证码、强密码、恢复码、设备会话、二次验证、超管TOTP、注销冷静期与受审计维护恢复。
- 消息与协作：好友申请/屏蔽、私聊、群角色与邀请审核、历史同步、离线重试、图片/文件、表情、回复、提及、反应、撤回、收藏、搜索和通知。
- 待办：个人/群任务、负责人、检查项、截止日期/时区、列表/看板、评论、提醒、来源、实时卡片、静态副本和本人确认的离线草稿恢复。
- 全站后台：监控/告警、账号/会话/关系/群组、内容/文件治理、配置版本、公告/举报、批量任务、审计、受控导出、备份与隔离恢复演练。

站点超管可按受审计流程审阅私聊、群聊和附件；本产品不提供端到端加密。个人待办遵循独立权限，超管不能在普通查询里任意浏览个人任务。群消息按本次加入后的范围读取；群待办当前摘要对现成员可见，评论/活动与来源仍受各自权限限制。

## 开发、检查与数据

```text
npm run dev
npm run build
npm run check
```

开发模式前端为 `http://localhost:5173`，后端为 `http://127.0.0.1:8765`；构建后由后端同源提供界面。检查使用项目 `.codex` 内隔离合成数据。开发默认库为 `var/data/tongpin.sqlite3`，附件/备份/导出/日志位于非公开目录。常驻服务使用一个ASGI进程、一个SQLite数据目录和进程内有界缓存，不要对同一个库启动多个worker或多副本。

生产模式要求准确HTTPS来源、外部密钥、正式运营资料、非开发条款和持久目录，并执行只读发布预检。CI配置Windows/macOS/Linux的真实HTTP/WS/SQLite、恢复与脚本检查；通过情况以实际运行记录为准，不等同于实机手机或全部Linux发行版验收。

- [安装、依赖与平台入口](docs/INSTALL.zh-CN.md)
- [配置参考](docs/CONFIGURATION.zh-CN.md)
- [用户说明](docs/USER_GUIDE.zh-CN.md)
- [超级管理员说明](docs/ADMIN_GUIDE.zh-CN.md)
- [部署、备份、监控、升级与回滚](docs/OPERATIONS.zh-CN.md)
- [当前接口](implementation/API_CURRENT.zh-CN.md)

发布包先在本地生成和校验，不自动上传公开Release、购买服务或部署生产环境。

许可证：[Apache-2.0](LICENSE)。
