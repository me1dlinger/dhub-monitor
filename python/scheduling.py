"""Shared scheduler wiring, used by both the standalone and embedded schedulers.

Keeping the job definitions in one place guarantees that ``python scheduler.py``
and the embedded scheduler behave identically.
"""

import logging
from datetime import datetime, timedelta

from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from config import LOCAL_TZ, REFRESH_CRON, REFRESH_INTERVAL_HOURS, iso_now, now_local
from database import get_state, set_state
from refresh import run_refresh

logger = logging.getLogger(__name__)

HEARTBEAT_SECONDS = 60


def build_trigger():
    """Prefer on-the-hour scheduling; fall back to a plain interval.

    * ``REFRESH_CRON`` wins when set.
    * Otherwise, when the interval divides 24 evenly we fire on the hour
      (e.g. every 2h -> 00:00, 02:00, ... 22:00).
    * Otherwise (5h, 7h, ...) an interval trigger anchored to startup is used.
    """
    if REFRESH_CRON:
        return CronTrigger.from_crontab(REFRESH_CRON, timezone=LOCAL_TZ)
    if 24 % REFRESH_INTERVAL_HOURS == 0:
        return CronTrigger(hour=f'*/{REFRESH_INTERVAL_HOURS}', minute=0, timezone=LOCAL_TZ)
    return IntervalTrigger(hours=REFRESH_INTERVAL_HOURS)


def heartbeat():
    set_state('scheduler_heartbeat', iso_now())


def scheduled_refresh():
    run_refresh('scheduled')
    heartbeat()


def needs_initial_refresh():
    last = get_state('last_refresh_at')
    if not last:
        return True
    try:
        last_dt = datetime.fromisoformat(last)
    except ValueError:
        return True
    return now_local().replace(tzinfo=None) - last_dt >= timedelta(hours=REFRESH_INTERVAL_HOURS)


def configure(scheduler):
    """Register the refresh and heartbeat jobs on ``scheduler``."""
    set_state('scheduler_started_at', iso_now())
    set_state('scheduler_interval_hours', REFRESH_INTERVAL_HOURS)
    heartbeat()

    scheduler.add_job(
        scheduled_refresh,
        build_trigger(),
        id='refresh',
        max_instances=1,
        coalesce=True,
        misfire_grace_time=3600,
        replace_existing=True,
    )
    scheduler.add_job(
        heartbeat,
        IntervalTrigger(seconds=HEARTBEAT_SECONDS),
        id='heartbeat',
        max_instances=1,
        coalesce=True,
        misfire_grace_time=HEARTBEAT_SECONDS,
        replace_existing=True,
    )
    if needs_initial_refresh():
        logger.info('no recent refresh found, scheduling one shortly after startup')
        scheduler.add_job(
            scheduled_refresh,
            'date',
            run_date=now_local() + timedelta(seconds=5),
            id='initial_refresh',
            replace_existing=True,
        )
    return scheduler
