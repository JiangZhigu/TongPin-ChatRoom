# M9：可部署交付准备

更新：2026-09-12。状态：脚本、本机定向检查和CI配置已实现，最终源码冻结回归、三平台CI、发布包及真实升级/回滚演练正在完成。未进行生产上线。

## 已实现的入口

- Windows的 `tongpin.cmd` / `tongpin.ps1` 与macOS/Linux的 `tongpin.sh` 共用 `scripts/deploy.py`，从自身目录定位工程，优先本版本 `.venv`，再实际探测可用解释器。
- `doctor` 只读检查系统/发行版、运行时与包管理器；`install` 只安装本项目锁定环境，明确是否允许项目内Python下载。无sudo、系统服务安装或全局配置修改。
- `precheck` 使用候选版本自己的解释器，只读核对生产配置、HTTPS来源、外部密钥、数据库/迁移、首位管理员及第二因素、运营信息/条款、磁盘和文件策略；缺项返回非零，生产启动会重做预检。
- `activate` / `rollback` 使用控制锁、数据实例锁、候选文件/解释器验证、升级前逐文件快照、迁移与SQLite完整性检查，最后原子切换版本指针。版本、数据、控制和快照目录分离。回滚只切换兼容代码，不倒退当前消息、权限或凭据消费。
- `release.py` 检查前端构建回执与已提交交付文件，创建带逐文件清单的ZIP及SHA256；暂存先完整验证，再写全新目录，拒绝路径穿越、链接、大小写冲突、Windows保留路径与超限包。激活时重核对解压后的清单。
- Docker分阶段构建，运行用户10001、单实例、持久挂载、健康检查；Compose使用只读根目录、有限tmpfs、移除capabilities、主机回环端口。提供Nginx、systemd、launchd及Windows前台托管模板。

具体操作见 [安装](../docs/INSTALL.zh-CN.md)、[配置](../docs/CONFIGURATION.zh-CN.md)、[用户指南](../docs/USER_GUIDE.zh-CN.md)、[管理员指南](../docs/ADMIN_GUIDE.zh-CN.md)、[运维与升级](../docs/OPERATIONS.zh-CN.md)。本地相对文档链接已经检查。

## 本机已执行

部署专属14项测试全部通过，包括归档哈希/条目检查、拒绝覆盖、解压后文件变更拒绝、前端回执来源/产物变更、快照字节及隔离、实例锁与兼容schema指针回滚、真实离线运营配置审计、从外部工作目录执行CMD入口、生产预检失败/通过前后数据库哈希不变。指针用例明确隔离了依赖探测，其结论不代替下面的真实发布演练。

真实服务检查：正式 `python -m tongpin` 入口启动，WebSocket101、提交后ACK、其他成员HTTP读取、恰好一条持久消息、完整性/外键及进程停止均通过。不是Flask内存适配器检查。

Windows真实浏览器检查 `M9-CI-BROWSER-01-03`：Chromium153.0.8010.12，两个隔离context；真实Socket.IO连接、消息未刷新接收/刷新后保留；通过界面创建个人待办并刷新后读取。独立数据库确认消息和待办各一条。聊天/待办320、768、1440六个视口无横向溢出，console/pageerror/意外网络/5xx为0。测试服务停止，临时会话文件删除。初次缺少锁定浏览器及之后脚本等待不足的失败报告保留，修复的是检查脚本。

该浏览器脚本属于CI冒烟检查，不抵扣用户指定的最终新Astra browser-use完整体验。真实软键盘、物理输入法、目标主机TLS/防火墙/独立故障域备份仍须分别记录。

## 三平台CI与发布状态

[CI配置](../.github/workflows/ci.yml) 使用公开仓库标准 `ubuntu-latest`、`windows-latest`、`macos-latest`；锁定Python3.12.13、Node24.15.0、uv0.11.27，构建后检查真实HTTP/WS、SQLite、缓存、文件、恢复、部署脚本和浏览器。另一个标准Ubuntu任务构建Docker镜像，并在只读根目录/持久挂载下运行镜像内HTTP和WS检查。

2026-09-12再次核对仓库为public、具有push权限。官方文档确认公开仓库标准运行器免费；larger runner始终收费。本工作流不使用larger runner、缓存上传、产物上传、Packages或其他计费资源。[GitHub Actions计费说明](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。CI结果和最终提交将在实际完成后填写，配置存在不等于三平台通过。

发布ZIP、SHA256、安装目录和升级/回滚演练的实测结果尚待生成；当前不列虚构下载链接或版本号。生产域名、主机、TLS证书和真实运营密钥未配置，M9实际上线不在默认授权内。
