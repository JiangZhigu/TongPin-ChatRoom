# 已构建前端发布包：只需手动安装 Python

本包已包含前端页面，部署时不需要 Node.js 或 npm。Windows、Linux 和 macOS 使用同一份 ZIP；解压后先阅读本文件。

## 准备条件

- 手动安装可从命令行调用的 **Python 3.12 或更新版本**。这是安装入口使用的解释器。
- 首次安装需要联网：安装器在缺少 uv 时从官方 PyPI 下载并校验 uv，随后复用或下载项目锁定的 **Python 3.12.13**，并安装 `uv.lock` 中的后端依赖。
- 工具、Python 和依赖分别保存在解压目录内的 `.codex/tools`、`.codex/python`、`.codex/cache` 和 `.venv`；安装器不会要求管理员权限或修改系统 PATH。
- 解压到有写入权限的独立目录。不要覆盖旧版本的目录；旧数据保留在原来的数据目录，需要升级时请按项目的部署与迁移说明操作。

本包不包含聊天记录、账号、密码、密钥、运行中的数据库或其他机器的虚拟环境，也不属于离线安装包。

## Windows

1. 解压 ZIP，双击 **`install.cmd`**，等待安装完成。
2. 在解压目录打开 PowerShell，初始化首位管理员（首次部署执行一次）：

   ```powershell
   .\tongpin.cmd manage init-admin
   ```

3. 启动：

   ```powershell
   .\tongpin.cmd run
   ```

如果终端中 Python 已可用，但系统执行策略阻止 PowerShell 脚本，可直接使用 Python 入口，无需改变系统执行策略：

```powershell
python .\scripts\deploy.py install --bootstrap-tools --download-python
python .\scripts\deploy.py manage init-admin
python .\scripts\deploy.py run
```

如果 Python 只通过 `py` 启动，将上述 `python` 换成 `py`。

## Linux / macOS

在解压目录打开终端，执行：

```sh
sh ./install.sh
sh ./tongpin.sh manage init-admin
sh ./tongpin.sh run
```

使用 `sh` 调用不依赖 ZIP 是否保留脚本的可执行权限。也可以用 `python3 ./scripts/deploy.py` 替代 `sh ./tongpin.sh`。

## 使用与保存

服务启动后，在本机打开 <http://127.0.0.1:8765>。关闭服务时按 Ctrl+C，等待正常退出。

管理员初始化会交互询问用户名、密码和验证器动态码，并显示只出现一次的恢复码；没有预设管理员密码。普通账号可以按站点注册策略注册。

默认数据保存在本目录的 `var`，包括数据库和上传文件。升级或移动部署前应备份数据。对公网提供服务时，还需要独立配置域名、HTTPS、外部持久化目录及生产配置；本包的本机启动不等同于生产预检通过。

以后在同一台机器使用这个解压目录，直接运行 `tongpin.cmd run` 或 `sh ./tongpin.sh run` 即可；不必每次重新安装。

## 安装失败时

保留错误提示并重新运行安装入口。下载文件会校验 SHA-256；校验失败不会启动该工具。网络代理和证书沿用当前进程环境，不会修改系统网络设置。若操作系统或架构没有匹配的工具发行文件，脚本会明确停止，不能据此认为平台已完成验证。
