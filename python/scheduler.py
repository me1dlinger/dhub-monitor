"""Standalone scheduler process.

Runs independently from the web process so a busy or restarting web server can
never stop the periodic refresh, and a crash here is recovered by supervisord.
The web process can also run an embedded scheduler (``EMBEDDED_SCHEDULER``); use
one or the other, never both.
"""

import logging
import signal
import sys

from apscheduler.schedulers.blocking import BlockingScheduler

from config import LOCAL_TZ, REFRESH_INTERVAL_HOURS
from database import init_db
from scheduling import configure

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s [scheduler] %(message)s',
)
logger = logging.getLogger(__name__)


def main():
    init_db()
    scheduler = configure(BlockingScheduler(timezone=LOCAL_TZ))

    def shutdown(signum, frame):
        logger.info('received signal %s, shutting down', signum)
        try:
            scheduler.shutdown(wait=False)
        except Exception:
            pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    logger.info('scheduler started, refreshing every %s hour(s)', REFRESH_INTERVAL_HOURS)
    try:
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        pass


if __name__ == '__main__':
    main()
