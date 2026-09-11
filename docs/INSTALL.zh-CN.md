# 安装与平台入口

项目锁定Python3.12.13和Python依赖清单 `uv.lock`。验证的uv版本为0.11.27；源码构建使用Node24.x（最低24.15.0）、npm11.x（最低11.12.1）及 `package-lock.json`。发布包已有前端时只需Python和uv。Docker路径需要由主机管理员事先提供Docker/Compose。

`tongpin.cmd`、`tongpin.ps1`、`tongpin.sh` 从自身目录定位 `scripts/deploy.py`，优先探测项目 `.venv`，再实际执行已安装解释器的版本探针。从外部目录调用同样有效。安装只创建项目环境；`--download-python` 额外允许项目内Python下载，不自动提权或全局安装。

`doctor` 只读显示平台、Python/SQLite、命令位置和Linux的ID/ID_LIKE/VERSION_ID。检测apt、dnf/yum、zypper、pacman、apk、brew、winget等命令；发行版包版本过旧时由运营者选择认可的官方二进制或uv项目内Python。没有systemd/launchd时可将前台 `run` 交给已批准的进程管理器。系统服务模板不会被自动安装或启动。

## 安装、初始化、启动

Windows PowerShell：

```powershell
.\tongpin.cmd doctor
.\tongpin.cmd install --dev --build
.\tongpin.cmd manage init-admin
.\tongpin.cmd run
```

macOS/Linux：

```sh
sh ./tongpin.sh doctor
sh ./tongpin.sh install --dev --build
sh ./tongpin.sh manage init-admin
sh ./tongpin.sh run
```

使用 `sh` 不依赖ZIP是否保留可执行位。路径含空格时加引号。uv不在PATH时，在当前会话设置 `TONGPIN_UV` 为实际uv绝对路径；脚本不修改系统PATH。

若Windows执行策略阻止PowerShell脚本，直接调用已有Python，例如 `& '.\.venv\Scripts\python.exe' '.\scripts\deploy.py' doctor`；首次没有虚拟环境时使用已安装Python3.12+。不需要为此关闭系统执行策略。

`manage init-admin` 要求服务已停止，取数据目录单实例锁，交互输入用户名、显示名、15–128字符密码和验证器动态码，保存只显示一次的密码恢复码及独立第二因素恢复码。密码不经过命令参数。已有超管时拒绝再次初始化。

本机开发若需开放普通注册，可停止服务后使用 `manage registration open --reason "本机隔离联调开放注册"`。生产不允许通过此离线命令直接开放注册，先完成预检，再由后台运营配置决定。

| 参数 | 作用 |
|---|---|
| `doctor` | 只读依赖/平台检查 |
| `install --dev --build` | 安装锁定开发依赖并构建 |
| `install` | 安装发布包运行依赖，要求已有前端 |
| `manage init-admin` | 本地首位超管初始化 |
| `manage status` | 离线管理状态；会执行正常初始化链并获取实例锁 |
| `--env-file <绝对路径> precheck` | 只读生产预检 |
| `--env-file <绝对路径> run` | 按外部配置启动当前版本 |
| `run --state <active.json>` | 启动部署状态指定的版本与数据 |

全局 `--env-file` 放在子命令前。停止时按Ctrl+C并等待；托管服务使用对应服务管理器停止。升级不会自动停止正在运行的实例。
