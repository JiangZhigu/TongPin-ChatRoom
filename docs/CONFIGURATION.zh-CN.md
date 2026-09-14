# 配置参考

启动环境和数据库内的版本化运营策略分别管理。环境变量优先于 `.env` / `--env-file`；文件只接受 `TONGPIN_` 键，不执行shell或展开变量。生产配置放在独立受保护目录，不放发布目录或代码仓库。

| 环境变量 | 默认/要求 |
|---|---|
| `TONGPIN_ENV` | development；可选test/production |
| `TONGPIN_HOST` | 127.0.0.1；开发/测试仅回环 |
| `TONGPIN_PORT` | 8765 |
| `TONGPIN_DATA_DIR` | 项目var；生产使用专用持久绝对路径 |
| `TONGPIN_ORIGINS` | 逗号分隔的准确来源，不带路径或通配符；生产全部HTTPS |
| `TONGPIN_SECRET` | 生产外部提供且至少32字节；开发为空时生成development.key |
| `TONGPIN_CLAMD_HOST` | 127.0.0.1，仅可用127.0.0.1或::1 |
| `TONGPIN_CLAMD_PORT` | 0表示未启用，其他值为实际本地端口 |
| `TONGPIN_ALLOW_UNSCANNED_FILES` | 0；生产禁止1；测试放行仍记录not_scanned |
| `TONGPIN_FEATURE_TASKS` | 1；关闭时API不可用、聊天卡片中性降级 |
| `TONGPIN_FEATURE_TASKS_ENHANCED` | 1；控制增强任务能力 |
| `TONGPIN_TASK_PERSONAL_QUOTA` | 5000，正整数且不超过5000 |
| `TONGPIN_TASK_GROUP_QUOTA` | 10000，正整数且不超过10000 |
| `TONGPIN_UV` | 仅安装工具使用，指定现有uv绝对路径 |

环境配置需要重启。切换数据路径要求停机且应按迁移流程操作；升级脚本不允许悄悄换库。密钥影响会话、恢复凭据和第二因素加密，升级必须沿用原密钥。快照不复制外部环境文件；生产密钥由运营者独立保护备份。开发 `development.key` 包含在升级快照中。

后台运营策略包含注册模式、消息/附件配额、保留期、群数量、维护模式、运营信息、条款版本及监控阈值。提交前预览影响，执行时二次验证和版本比较；保留版本历史及受审计回滚。页面会区分需重启参数。

生产首次启动前，以外部配置设置运营信息：

```text
tongpin --env-file /protected/production.env manage operator --name "实际运营者" --contact "实际联系渠道" --terms-version "2026-09-reviewed-1" --reason "上线前完成运营信息核对"
```

示例中的 `tongpin` 代表 `tongpin.cmd` 或 `sh tongpin.sh`。命令创建策略版本和审计，保留注册模式。填写实际核对过的条款版本，不能用占位名冒充正式审定；注册页面展示运营资料及实际数据处理规则。

生产预检核对HTTPS/密钥、前端、专用路径、可正常登录且无需强制改密的超管、迁移原始SQL校验和、SQLite完整性/外键、运营信息、非开发条款、严格文件策略和磁盘水位。扫描器未启用/不可达时警告，一般文件保持隔离，不假报clean。目标主机的TLS证书、防火墙、外部可达性、文件权限及独立故障域备份仍需另外核验。
