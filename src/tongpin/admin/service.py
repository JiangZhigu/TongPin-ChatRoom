from __future__ import annotations

from tongpin.admin.commands import CommandsAdmin
from tongpin.admin.groups import GroupsAdmin
from tongpin.admin.monitoring import MonitoringAdmin
from tongpin.admin.relations import RelationsAdmin
from tongpin.admin.sessions import SessionsAdmin
from tongpin.admin.users import UsersAdmin
from tongpin.infra.cache import BoundedCache


class AdminService(
    CommandsAdmin, UsersAdmin, SessionsAdmin, RelationsAdmin, GroupsAdmin, MonitoringAdmin
):
    def __init__(self, runtime):
        self.runtime = runtime
        self.secrets = BoundedCache(max_entries=100, max_bytes=128 * 1024, ttl=300)
