# 已构建前端发布包：自动检测系统并安装 Python

本包已包含前端页面，部署时不需要 Node.js 或 npm。Windows、Linux 和 macOS 使用同一份 ZIP；没有 Python 时，安装入口会尝试通过对应包管理器自动安装。

## 准备条件

- 使用受支持的 **x86_64 / ARM64** 系统，并能连接系统软件源、PyPI 和 Python 下载源。
- 已有可用的 **Python 3.8 或更新版本**时，安装器复用它进行引导；没有时先通过系统包管理器安装。系统仓库提供的 3.8–3.11 也可以引导，项目实际运行版本始终为 **Python 3.12.13**。
- Linux 安装系统包需要 root、sudo 或 doas；macOS 首次安装 Homebrew 可能需要管理员密码与 Apple Command Line Tools。Windows 使用现有 winget，按当前用户范围安装。
- 随后，安装器准备缺少的 uv，复用或下载锁定的 Python，并安装 `uv.lock` 中的后端依赖。项目依赖不会写入系统 Python。
- 系统包管理器安装的引导 Python 位于它的标准位置。项目内的工具、下载的运行时、缓存和虚拟环境分别位于 `.codex/tools`、`.codex/python`、`.codex/cache` 和 `.venv`。
- 解压到有写入权限的独立目录。不要覆盖旧版本的目录；旧数据保留在原来的数据目录，需要升级时请按项目的部署与迁移说明操作。

本包不包含聊天记录、账号、密码、密钥、运行中的数据库或其他机器的虚拟环境，也不属于离线安装包。

## 自动检测与包管理器

| 系统 / 发行版 | 缺少 Python 时的处理 |
|---|---|
| Ubuntu、Debian、Linux Mint 及声明兼容的衍生版 | `apt-get update` 后安装 `python3` 与 `ca-certificates` |
| Fedora、现代 RHEL / Rocky / AlmaLinux 等 RPM 系列 | 优先 `dnf`，其次 `yum`；通常安装 `python3`，RHEL 8 系列选择 `python3.12` |
| Arch、Manjaro | `pacman -S --needed --noconfirm python ca-certificates`，不自动执行全系统升级 |
| openSUSE、SLES | `zypper --non-interactive install python311 ca-certificates` |
| Alpine | `apk add --no-cache python3 ca-certificates` |
| macOS | 优先已有 Homebrew，安装 `python@3.12`；已有 MacPorts 时可安装 `python312`；两者都没有时先准备 Homebrew |
| Windows x64 / ARM64 | 通过 winget 安装 `Python.Python.3.12`，使用 `--scope user`；安装后重新查找解释器，不依赖当前终端刷新 PATH |

Linux 从 `/etc/os-release`（缺少时读取 `/usr/lib/os-release`）读取 `ID`、`ID_LIKE` 和 `VERSION_ID`，不会把文件作为脚本执行。仅使用已经配置的软件源，不添加 PPA 或替换系统默认 Python。老旧发行版若无法提供 Python 3.8+ 或表中的软件包，会停止并说明原因；不保证全部发行版和历史版本均可安装。

macOS 的 Homebrew 安装脚本来自固定官方提交，下载后先核对 SHA-256，再运行。它可能安装 Apple Command Line Tools，并使用其标准 Homebrew 目录。请用普通账号运行 `sh ./install.sh`，需要时由 sudo 单独提示认证，不要整体使用 `sudo sh ./install.sh`。

Windows 若没有 winget，脚本会明确停止；可先安装微软 App Installer（[官方入口](https://aka.ms/getwinget)），或自行安装 Python 3.8+ 后重试。脚本不会修改 PowerShell 执行策略、强制重启或自动切换另一种安装器。

包管理器只负责引导 Python，例如 winget 的 3.12 分支可能提供 3.12.10、Debian 12 默认提供 3.11。后续项目环境仍会按照 `.python-version` 准备 **3.12.13**。

## 先查看安装计划

无需 Python 即可执行只读预览；不会下载文件、调用软件包安装或启动项目安装器：

```powershell
.\install.cmd --dry-run
```

```sh
sh ./install.sh --dry-run
```

`--help` 显示参数说明。可选 `--dev --build` 用于从源码构建，此时还需要预先提供 Node.js / npm。

## Windows

1. 解压 ZIP，双击 **`install.cmd`**，根据系统提示完成必要授权，等待安装完成。
2. 在解压目录打开 PowerShell，初始化首位管理员（首次部署执行一次）：

   ```powershell
   .\tongpin.cmd manage init-admin
   ```

3. 启动：

   ```powershell
   .\tongpin.cmd run
   ```

如果系统执行策略阻止 PowerShell 脚本，安装器不会绕过策略。已有 Python 3.8+ 时可直接调用引导入口，无需改变执行策略：

```powershell
python .\scripts\bootstrap_runtime.py
.\.venv\Scripts\python.exe .\scripts\deploy.py manage init-admin
.\.venv\Scripts\python.exe .\scripts\deploy.py run
```

如果 Python 只通过 `py` 启动，将上述 `python` 换成 `py`。

## Linux / macOS

在解压目录打开终端，执行：

```sh
sh ./install.sh
sh ./tongpin.sh manage init-admin
sh ./tongpin.sh run
```

使用 `sh` 调用不依赖 ZIP 是否保留脚本的可执行权限。只有系统包安装步骤会使用 sudo 或 doas；项目环境继续以当前用户创建。安装后也可以用 `.venv/bin/python ./scripts/deploy.py` 替代 `sh ./tongpin.sh`。

## 使用与保存

服务启动后，在本机打开 <http://127.0.0.1:8765>。关闭服务时按 Ctrl+C，等待正常退出。

管理员初始化会交互询问用户名、密码和验证器动态码，并显示只出现一次的恢复码；没有预设管理员密码。普通账号可以按站点注册策略注册。

默认数据保存在本目录的 `var`，包括数据库和上传文件。升级或移动部署前应备份数据。对公网提供服务时，还需要独立配置域名、HTTPS、外部持久化目录及生产配置；本包的本机启动不等同于生产预检通过。

以后在同一台机器使用这个解压目录，直接运行 `tongpin.cmd run` 或 `sh ./tongpin.sh run` 即可；不必每次重新安装。

## 安装失败时

安装失败或取消认证后，脚本立即停止，不会自动重试、换包管理器或启动应用。请先查看错误和当前安装状态，再决定是否重新运行。

- **权限不足**：使用有安装权限的账号，或提供可用的 sudo / doas；不要把密码写入脚本或命令参数。
- **包不存在 / 软件源不可达**：核对发行版版本和已有源。Arch 如果软件库过旧，请先按发行版维护流程更新系统，本脚本不自动进行全系统升级。
- **下载校验失败**：保留日志；校验失败的工具或 Homebrew 安装脚本不会执行。网络代理与证书沿用当前进程配置。
- **系统包已安装，但项目安装失败**：已安装的 Python / Homebrew 会保留，以便检查和重试；脚本不会为回滚而自动卸载共享依赖。确认不再需要时，可通过原包管理器移除本次新装的 Python；移除 Homebrew 前还需确认其中没有其他软件。不要把卸载系统软件与删除聊天数据混为一谈。

## 验证范围与参考

自动选择包管理器、缺少 Python、成功后重新发现解释器、提权失败与取消、只读预览等分支均使用隔离命令替身测试。本轮不以这些测试声称已在真实 Linux/macOS 主机上完成系统安装，也没有为测试而卸载当前 Windows 的 Python。

对应行为参照 [WinGet 安装参数](https://learn.microsoft.com/en-us/windows/package-manager/winget/install)、[Homebrew 安装要求](https://docs.brew.sh/Installation)、[Homebrew Python 3.12](https://formulae.brew.sh/formula/python@3.12)、[uv Python 管理](https://docs.astral.sh/uv/guides/install-python/) 与 [Arch 系统维护说明](https://wiki.archlinux.org/title/System_maintenance)。
