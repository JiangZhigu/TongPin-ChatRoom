# 同频 · TongPin ChatRoom

同频是基于 Python + Flask、Socket.IO、SQLite 和 React 的聊天产品。保持浅灰浅蓝聊天布局，逐步交付真实账号、好友私聊、群组、离线队列、图片文件及全站超级管理员后台。

当前交付：M1 基础工程已通过本机定向检查。账号与聊天业务正在后续阶段实现，当前入口会如实显示尚未启用；不是可对外运营的完成版本。进度见 [implementation/STATUS.md](implementation/STATUS.md)。

## 本地运行

需要 Python 3.12.13、uv、Node.js 24 和 npm 11。依赖安装限定在项目 .venv/node_modules，数据在项目 var，更新代码不清空数据。

```text
npm run setup
npm run dev
```

开发页面 http://localhost:5173，后端 http://127.0.0.1:8765。Ctrl+C 停止本入口启动的进程。

构建后由常驻后端同源提供前端：

```text
npm run build
npm start
```

配置可通过环境变量或根 .env 提供，示例见 [.env.example](.env.example)。项目内启动桥接优先使用根 .venv，从其他工作目录调用脚本时仍以项目根解析数据和资源。

## 检查与数据

```text
npm run check
```

检查使用隔离的项目 .codex 测试数据，不使用正式库。数据库为 var/data/tongpin.sqlite3，附件和临时文件在非公开目录；进程使用单实例锁、有界缓存和 SQLite WAL/FULL/外键。Windows/macOS/Linux 使用相同 Python 入口，平台实测范围以交付报告为准。

生产模式需要显式 HTTPS 来源和运营者提供的密钥；本项目不会自动创建云资源、配置生产密钥或部署。FE-1 开发授权、后续重大事项与阶段交付分别记录在 implementation 中。

许可证：[Apache-2.0](LICENSE)。
创建一个自己的聊天室
