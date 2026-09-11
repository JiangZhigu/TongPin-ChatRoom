from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo


def local_instant(day: date, clock: str, zone: str) -> int:
    """Use the earliest fold; gaps advance to the first valid local minute."""
    hour, minute = map(int, clock.split(":"))
    naive = datetime.combine(day, time(hour, minute))
    timezone = ZoneInfo(zone)
    # Includes unusual date-line transitions that skip a complete local day.
    for offset in range(2881):
        candidate = naive + timedelta(minutes=offset)
        valid = []
        for fold in (0, 1):
            aware = candidate.replace(tzinfo=timezone, fold=fold)
            utc = aware.astimezone(UTC)
            if utc.astimezone(timezone).replace(tzinfo=None) == candidate:
                valid.append(int(utc.timestamp() * 1000))
        if valid:
            return min(valid)
    raise ValueError("This timezone has no representable local instant near this date")


def due_bounds(day: str | None, timezone: str):
    if day is None:
        return None, None
    value = date.fromisoformat(day)
    return local_instant(value, "00:00", timezone), local_instant(
        value + timedelta(days=1), "00:00", timezone
    )
