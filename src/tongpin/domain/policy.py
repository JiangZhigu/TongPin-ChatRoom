from __future__ import annotations

import json

from tongpin.config import DEFAULT_POLICY


class PolicyService:
    def __init__(self, runtime):
        self.runtime = runtime

    def get(self, connection=None):
        if connection is None:
            with self.runtime.db.read() as conn:
                return self.get(conn)
        row = connection.execute(
            "SELECT version,values_json FROM policy_versions ORDER BY version DESC LIMIT 1"
        ).fetchone()
        values = dict(DEFAULT_POLICY)
        if row:
            values.update(json.loads(row["values_json"]))
        return values | {"version": row["version"] if row else 0}

    def terms(self):
        policy = self.get()
        return {
            "version": policy["terms_version"],
            "operatorName": policy["operator_name"],
            "operatorContact": policy["operator_contact"],
            "development": not self.runtime.settings.production,
            "text": f"同频服务由站点运营者管理。全站超级管理员可以审阅私聊、群聊和附件，敏感访问会记录审计；本服务不提供端到端加密。未删除消息默认持续保存；撤回或管理删除的内容立即对普通用户隐藏，当前管理保留期为{policy['deleted_content_days']}天；审计保留{policy['audit_days']}天。注销有{policy['deletion_cooling_days']}天冷静期，注销后共享消息按保留规则保存并显示已注销身份。请妥善离线保存恢复码；密码和恢复码均丢失时没有自动找回后门，只能联系运营者进行人工核验。文件白名单不能保证文件安全，请谨慎下载和打开。"
            + " 个人待办仅本人通过普通接口访问；运营人员没有全站个人待办列表、搜索或导出入口，仅可按本人提交的具体举报及最小必要材料受审计处理。已发送的静态副本属于聊天内容，仍适用聊天审阅规则，不可据此追溯原个人待办。群待办摘要、描述及检查项对当前成员可见，评论与活动仅限本次加入后。待办回收及群解散后的保留期为30天；未结举报保留具体对象，结案后继续保留30天。"
            + (
                " 当前为本地开发/测试环境，不能将此说明视为正式运营者已审定的法律文本。"
                if not self.runtime.settings.production
                else ""
            ),
        }
