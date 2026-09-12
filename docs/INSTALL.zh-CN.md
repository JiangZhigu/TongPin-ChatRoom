# 安装与平台入口

项目运行时锁定Python3.12.13和Python依赖清单 `uv.lock`，uv版本为0.11.27。**已构建前端的发布ZIP可以从没有Python的机器开始安装**：原生入口检测系统、架构和Linux发行版，复用Python3.8+或通过对应包管理器安装引导Python，再准备项目锁定运行时、uv和后端依赖。首次安装需要联网及系统包管理器所需权限，不需要Node.js、npm或手动安装uv。源码构建另需Node24.x（最低24.15.0）、npm11.x（最低11.12.1）及 `package-lock.json`。Docker路径需要由主机管理员事先提供Docker/Compose。

Windows的 `install.cmd` 使用已有winget并指定当前用户安装范围；Linux的 `install.sh` 使用apt-get、dnf/yum、pacman、zypper或apk；macOS优先已有Homebrew/MacPorts，两者都没有时从固定官方提交下载并校验Homebrew安装器。Linux安装系统包时使用root、sudo或doas；macOS可能要求管理员认证及Command Line Tools。项目依赖仍在 `.venv` 中，不安装进系统Python。完整版本边界见[自动安装说明](../INSTALL-PYTHON.zh-CN.md)。

`tongpin.cmd`、`tongpin.ps1`、`tongpin.sh` 从自身目录定位 `scripts/deploy.py`，优先探测项目 `.venv`，再实际执行已安装解释器的版本探针。从外部目录调用同样有效。`--bootstrap-tools` 允许缺少uv时从官方PyPI取得匹配发行文件并校验，`--download-python` 允许下载项目锁定的Python；两者均使用项目目录，不自动提权、修改系统PATH或全局安装。

尚无Python时，先使用 `install.cmd --dry-run` 或 `sh ./install.sh --dry-run` 只读查看检测结果和安装计划。安装后可用 `doctor` 查看Python/SQLite、命令位置和Linux信息；`doctor`及其他直接 `tongpin` 命令自身需要Python3.12+。没有systemd/launchd时可将前台 `run` 交给已批准的进程管理器。系统服务模板不会被自动安装或启动。

## 安装、初始化、启动

### 已构建前端的发布ZIP

解压到有写入权限的新目录，保留旧版本和旧数据。Windows双击 `install.cmd`；Linux/macOS运行 `sh ./install.sh`。原生入口先准备引导解释器，再进入 `--bootstrap-tools --download-python` 项目安装流程。安装完成后执行管理员初始化和启动：

```powershell
.\tongpin.cmd manage init-admin
.\tongpin.cmd run
```

```sh
sh ./tongpin.sh manage init-admin
sh ./tongpin.sh run
```

具体准备条件和直接Python回退见[自动安装说明](../INSTALL-PYTHON.zh-CN.md)。系统包管理器安装的引导Python使用系统标准位置；项目工具、下载的运行时、缓存和虚拟环境分别位于 `.codex/tools`、`.codex/python`、`.codex/cache` 和 `.venv`。已有符合要求的工具可以复用；损坏的已记录缓存会明确拒绝，不能因重新运行入口而假报安装成功。

### 从源码安装并构建

Windows PowerShell：

```powershell
.\install.cmd --dev --build
.\tongpin.cmd doctor
.\tongpin.cmd manage init-admin
.\tongpin.cmd run
```

macOS/Linux：

```sh
sh ./install.sh --dev --build
sh ./tongpin.sh doctor
sh ./tongpin.sh manage init-admin
sh ./tongpin.sh run
```

使用 `sh` 不依赖ZIP是否保留可执行位。路径含空格时加引号。uv不在PATH时，在当前会话设置 `TONGPIN_UV` 为实际uv绝对路径；脚本不修改系统PATH。

若Windows执行策略阻止PowerShell脚本，脚本不会绕过它。已有Python3.8+时可直接运行 `python scripts/bootstrap_runtime.py`（源码构建追加 `--dev --build`）；安装后可使用 `& '.\.venv\Scripts\python.exe' '.\scripts\deploy.py' doctor` 等直接入口。完全没有Python且策略阻止原生入口时，需要按本机策略先安装引导解释器。

`manage init-admin` 要求服务已停止，取数据目录单实例锁，交互输入用户名、显示名、8–128字符密码和验证器动态码，保存只显示一次的密码恢复码及独立第二因素恢复码。密码不经过命令参数。已有超管时拒绝再次初始化。

新站默认开放普通注册，启动后可从登录页进入“注册”或访问 `/register`。升级会保留已经保存的开放、仅邀请码或关闭策略，不会自动改成开放。超管可在后台运营配置中调整策略。

本机开发若保留了旧站的关闭策略，确需通过离线命令改为开放时，可停止服务后使用 `manage registration open --reason "本机隔离联调开放注册"`。生产不允许通过此离线命令直接开放注册，先完成预检，再由后台运营配置决定。

| 参数 | 作用 |
|---|---|
| `doctor` | 只读依赖/平台检查 |
| `install --bootstrap-tools --download-python --dev --build` | 允许项目内工具/Python准备，安装锁定开发依赖并构建；需Node/npm |
| `install --bootstrap-tools --download-python` | 安装发布包运行依赖，要求已有前端；无需Node/npm |
| `install` | 复用已有uv与锁定Python安装运行依赖，不自动授权下载缺失工具或Python |
| `manage init-admin` | 本地首位超管初始化 |
| `manage status` | 离线管理状态；会执行正常初始化链并获取实例锁 |
| `--env-file <绝对路径> precheck` | 只读生产预检 |
| `--env-file <绝对路径> run` | 按外部配置启动当前版本 |
| `run --state <active.json>` | 启动部署状态指定的版本与数据 |

全局 `--env-file` 放在子命令前。停止时按Ctrl+C并等待；托管服务使用对应服务管理器停止。升级不会自动停止正在运行的实例。

## 已测平台与安装边界

新增的系统包管理器分支通过隔离替身验证缺少Python、发行版选择、提权取消、安装失败、解释器重新发现和只读预览。没有在测试主机上卸载Python或实际运行系统包安装，因此不把分支测试当作Linux/macOS/Windows原生冷安装通过。包管理器失败后不会自动换源、提权重试、全系统升级或回滚卸载共享依赖。

2026-09-12的Python安装包已在Windows x64全新解压目录中，使用无Node/npm/uv的进程PATH完成安装、启动和真实页面检查；缺少锁定Python时的项目内下载另有实际记录。该流程复用的工具/解释器范围见对应交付记录。Linux/macOS具有原生入口与平台测试，但这份Python安装包尚无两平台的原生冷安装证据，不能用模拟平台选择测试或历史源码CI替代。最新CI、候选版本及证据对应关系见[实施状态](../implementation/STATUS.md)。
