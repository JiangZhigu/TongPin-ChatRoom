from tongpin.tasks.commands import TaskCommands
from tongpin.tasks.enhanced import TaskEnhanced
from tongpin.tasks.policy import TaskPolicy
from tongpin.tasks.queries import TaskQueries
from tongpin.tasks.retention import TaskRetention
from tongpin.tasks.sharing import TaskSharing


class TaskService(TaskCommands, TaskEnhanced, TaskQueries, TaskSharing, TaskRetention, TaskPolicy):
    def __init__(self, runtime):
        self.runtime = runtime
