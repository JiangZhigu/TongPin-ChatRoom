# 部署、备份、监控、升级与回滚

本文提供可在目标主机审阅执行的操作步骤。仓库不自动申请域名、购买资源、设置生产密钥、安装系统服务或开放公网。实际测过的平台、版本与缺口见交付报告。

## 目录和配置

为版本、持久数据、控制文件、外部配置和升级快照使用独立目录，例如：

```text
/srv/tongpin/controller/          固定维护入口及其.venv
/srv/tongpin/releases/2026-09-a/   当前发布版本
/srv/tongpin/releases/2026-09-b/   下一发布版本
/srv/tongpin/persistent/          数据库、附件、临时区、备份、导出、日志
/srv/tongpin/control/active.json  原子写入的版本指针
/srv/tongpin/config/production.env
/srv/tongpin/upgrade-snapshots/   升级前字节校验快照
```

Windows可使用对应的 `C:\Tongpin\...` 目录。维护入口可以是一个已安装的、保留不覆盖的发布副本；运行 `deploy.py run --state` 时实际执行指针中的候选版本解释器。不要在发布目录内保存数据，也不要通过符号链接/junction绕开路径检查。数据文件只允许服务账号和授权维护账号读取，外部密钥另作受保护备份。

复制 [production.env.example](deployment/production.env.example) 到受保护配置目录，填写真实来源和密钥。空密钥不能通过生产配置验证。外部环境变量优先于文件；启动和维护时使用同一配置，避免旧会话加密材料丢失。

## 安装与发布预检

1. 在全新版本目录解压经校验的发布包，安装该版本自己的 `.venv`；不同版本不共用可变虚拟环境。
2. 停止服务后，用该版本的 `--env-file ... manage init-admin` 完成首位管理员/验证器设置；再使用 `manage operator` 写入真实运营信息和条款版本。
3. 执行 `--env-file ... precheck`。预检不会初始化或修复数据库，任何必需项缺失返回非零；扫描服务状态和目标主机外部验证项另外列出。
4. 生产 `run` 会再次调用候选版本自己的预检，通过后才进入正常单进程服务。后台注册默认关闭/邀请模式，开放注册由实际运营决定。

本文命令以通用Python入口表示；使用平台包装脚本时保留同样参数和顺序。全局 `--env-file` 必须位于子命令前。

## 反向代理和进程托管

后端保持一个ASGI进程、一个SQLite数据目录。不要设置多worker、多个容器副本共享SQLite，或添加未经实现的Redis依赖。使用本机回环反向代理，TLS终止在代理上，`TONGPIN_ORIGINS` 精确匹配最终HTTPS域名。

[Nginx模板](deployment/nginx.conf.example) 包含WebSocket升级头、26MiB请求体限制和足够的上传/心跳超时。替换域名和证书路径，先由主机管理员测试代理配置与证书，再启动；不要直接复制占位域名上线。代理只把请求转给回环后端，私有附件不配置静态目录别名。应用不信任任意客户端伪造转发头来放宽权限。

- Linux：[systemd模板](deployment/tongpin.service.example)。替换账号/绝对路径并限定持久目录可写；以普通服务账号运行，设置独立的主机日志保留。
- macOS：[launchd模板](deployment/com.tongpin.chat.plist.example)。替换REPLACE路径、预建受保护日志目录，通过用户批准的LaunchAgent/Daemon流程加载。长期服务应按主机策略轮转标准输出日志。
- Windows：[前台启动脚本模板](deployment/windows-start.ps1.example)。可在任务计划程序中使用专用账号、绝对路径和PowerShell无配置入口，启用失败重启；它不是原生Windows Service二进制，不能直接交给 `sc create` 冒充服务。若使用已批准的服务包装器，按包装器的停止/超时约定管理。

停止服务并等待进程退出后才能激活/回滚。脚本发现数据目录实例锁仍被占用会拒绝操作，不强杀其他进程。

## Docker / Compose

仓库的Dockerfile使用独立Node构建阶段和Python运行阶段，运行依赖来自锁文件；运行用户UID/GID为10001，Compose移除Linux capabilities、使用只读根文件系统、受限临时目录及单个持久挂载。镜像不会携带 `.env`、用户数据或本机依赖。

在主机上事先创建归属服务账号的专用持久目录。给当前部署会话设置 `TONGPIN_CONFIG_FILE` 和 `TONGPIN_PERSISTENT_DIR` 为真实绝对路径，然后：

```sh
docker compose build
docker compose run --rm --no-deps app manage init-admin
docker compose run --rm --no-deps app manage operator --name "实际运营者" --contact "实际联系渠道" --terms-version "已核对版本" --reason "上线前核对运营资料"
docker compose run --rm --no-deps app precheck
docker compose up -d
```

这组命令仅供已批准的目标主机执行。不要把初始化密码或生产密钥写入Dockerfile、镜像标签或命令参数。Compose只发布主机回环8765端口，外部TLS由主机代理管理。多个Compose项目指向同一持久目录仍会被实例锁拒绝。

Clamd接口仅允许显式回环地址。普通独立sidecar的服务DNS名不满足此要求；需要扫描时由运营者提供同一网络命名空间内的已配置扫描器，或选择适合主机部署的回环扫描服务。默认未安装扫描器时一般文档保持隔离，这不阻止纯聊天/图片场景，但不能声称文档已扫描。

## 创建、校验和暂存发布包

使用已经提交并审查的源码；`scripts/build.py` 生成前端构建前后指纹。打包会拒绝已跟踪脏改动、未提交的交付文件、缺少回执或与回执不一致的前端。

```text
python scripts/release.py package --output /protected/packages/tongpin-reviewed.zip
python scripts/release.py stage --bundle /protected/packages/tongpin-reviewed.zip --sha256 <独立记录的64位SHA256> --destination /srv/tongpin/releases/2026-09-b
```

发布ZIP包含源码、锁文件、脚本、文档与构建前端，附逐文件SHA256/体积和提交SHA；不包含 `.venv`、Node依赖、数据、生产密钥、设计ZIP、`.codex` 或IDE目录。压缩包旁生成 `.sha256`；通过可信渠道核对预期哈希，不能只信同来源下载文件自己提供的哈希。

暂存先核对整个ZIP与逐文件清单，拒绝路径穿越、链接、重复/大小写冲突、Windows保留名和超限包，再写全新目录；绝不覆盖现有目录。暂存成功尚未安装依赖，也未修改持久数据。进入新目录执行 `install` 后再激活。

## 升级与回滚

首次激活与后续升级使用同一入口，以下在固定维护入口执行：

```text
python scripts/deploy.py --env-file /srv/tongpin/config/production.env activate --state /srv/tongpin/control/active.json --release /srv/tongpin/releases/2026-09-b --data-dir /srv/tongpin/persistent --backup-dir /srv/tongpin/upgrade-snapshots
python scripts/deploy.py --env-file /srv/tongpin/config/production.env run --state /srv/tongpin/control/active.json
```

激活先取控制锁和数据实例锁，确认候选完整及解释器版本、迁移版本与原始SQL校验和。停机状态下复制数据库/附件/临时区/开发密钥，逐文件校验；再使用候选版本迁移并核对SQLite完整性/外键，最后原子更新指针。旧版本保留，服务不会自动启动。操作档案/日志保留原位，生产外部密钥不进入快照。

若迁移失败，版本指针不更新；已经完成的迁移可能仍在数据库中。保留现场和升级前快照，不直接用旧程序启动新schema，也不把“指针没变”理解为数据自动回退。应按快照和当前撤权/删除状态进行受控恢复评估。脚本不自动覆盖或倒退当前数据。

需要回滚代码时先停服务：

```text
python scripts/deploy.py --env-file /srv/tongpin/config/production.env rollback --state /srv/tongpin/control/active.json --backup-dir /srv/tongpin/upgrade-snapshots
```

回滚只接受记录的上一版本，而且迁移版本集合/字节校验和必须与当前数据库完全兼容；保留当前数据，再做快照并切换指针。若数据库已升级为旧版本不支持的schema则拒绝。代码回滚不能把用户消息、撤权、恢复码消费或已执行删除回到过去。跨schema恢复不是本命令的功能。

## 备份、恢复和监控

后台备份使用一致性数据库快照、必要附件和校验清单，保留默认7份日备份+4份周备份。生产还应由运营者将授权备份复制到独立故障域并按保留规则验证恢复；同盘快照无法抵御整盘损坏。密钥独立保护，原地升级快照不自动代替完整运营备份。

后台恢复功能先预检再做隔离演练，重放当前权限/凭据消费和删除规则，不直接切换正式数据。演练结果显示不可激活，不要把演练目录作为新生产数据启动。正式恢复需要保留当前权限账本、密钥、完整备份和明确恢复目标，由主机维护流程完成。

`/health/live` 检查进程存活，`/health/ready` 检查就绪状态；它们不能代替登录、WebSocket、实际文件读写和数据库恢复验证。全站监控页面每轮显示采样时间、进程资源、请求/WS/DB延迟、队列与告警。样本陈旧时先排查服务/执行队列，不能把旧值当成实时正常。外部监控可定期探测只读健康入口，并在自己的故障域保存告警；不要将后台凭据写入公开探针配置。

每次升级应在目标主机验证：入口、登录、一个真实WS消息及对端补收、附件字节、权限变更、备份预检、重启持久化和实际服务版本。镜像成功构建、端口监听、配置预检通过都不等于这组流程全部通过。
