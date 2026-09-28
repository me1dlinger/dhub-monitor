"""Central configuration, loaded from the environment (supports a local .env).

Importing this module never has side effects other than reading environment
variables, so it is safe to import from the web process, the scheduler process
and the CLI.
"""

import os
from datetime import datetime

from dotenv import load_dotenv

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Prefer the .env next to this file, fall back to the current working directory.
load_dotenv(os.path.join(BASE_DIR, '.env'))
load_dotenv()


def _get_int(name, default, minimum=None):
    raw = os.getenv(name)
    if raw is None or str(raw).strip() == '':
        value = default
    else:
        try:
            value = int(str(raw).strip())
        except (TypeError, ValueError):
            value = default
    if minimum is not None and value < minimum:
        value = minimum
    return value


def _get_str(name, default=''):
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip()


def _get_bool(name, default=False):
    value = os.getenv(name)
    if value is None or str(value).strip() == '':
        return default
    return str(value).strip().lower() in ('1', 'true', 'yes', 'on')


APP_NAME = _get_str('APP_NAME', 'Docker Hub Monitor') or 'Docker Hub Monitor'

# An empty secret disables authentication. Never fall back to a well-known
# default here: that would silently enable auth with a guessable password.
AUTH_SECRET = _get_str('AUTH_SECRET', '')

REFRESH_INTERVAL_HOURS = _get_int('REFRESH_INTERVAL', 6, minimum=1)
# Optional crontab expression (5 fields) that overrides the interval, e.g.
# "0 */2 * * *" for every 2 hours on the hour.
REFRESH_CRON = _get_str('REFRESH_CRON', '')
# Run the scheduler inside the web process (convenient for local development).
# Set to false when a dedicated scheduler process is running, as in Docker.
EMBEDDED_SCHEDULER = _get_bool('EMBEDDED_SCHEDULER', True)
DEFAULT_DAYS = _get_int('DEFAULT_DAYS', 14, minimum=1)
PORT = _get_int('PORT', 5000, minimum=1)
HOST = _get_str('HOST', '0.0.0.0') or '0.0.0.0'

FETCH_WORKERS = _get_int('FETCH_WORKERS', 4, minimum=1)
REQUEST_TIMEOUT = _get_int('REQUEST_TIMEOUT', 20, minimum=5)
TAGS_CACHE_TTL = _get_int('TAGS_CACHE_TTL', 6 * 3600, minimum=60)

# Docker Hub source. The metadata API is the only place pull_count exists, so a
# self-hosted gateway can be substituted here when the network needs one.
DOCKER_HUB_API = (_get_str('DOCKER_HUB_API', 'https://hub.docker.com/v2/repositories')
                  or 'https://hub.docker.com/v2/repositories').rstrip('/')
# Optional Personal Access Token. It raises the rate limit / reduces throttling
# but does not bypass a network block.
DOCKER_HUB_TOKEN = _get_str('DOCKER_HUB_TOKEN', '')

LOGIN_MAX_ATTEMPTS = _get_int('LOGIN_MAX_ATTEMPTS', 5, minimum=1)
LOGIN_LOCKOUT_SECONDS = _get_int('LOGIN_LOCKOUT_SECONDS', 300, minimum=30)

DATA_DIR = _get_str('DATA_DIR') or os.path.join(BASE_DIR, 'data')
DB_PATH = os.path.join(DATA_DIR, 'monitor.db')
LOCK_PATH = os.path.join(DATA_DIR, 'refresh.lock')

TIMEZONE = _get_str('TZ') or 'Asia/Shanghai'

try:
    from zoneinfo import ZoneInfo

    LOCAL_TZ = ZoneInfo(TIMEZONE)
except Exception:  # pragma: no cover - missing tzdata or unknown zone name
    from datetime import timezone as _timezone

    LOCAL_TZ = _timezone.utc


def now_local():
    """Current time in the configured timezone (aware)."""
    return datetime.now(LOCAL_TZ)


def iso_now():
    """Naive local ISO-8601 timestamp, second precision (used in the DB)."""
    return now_local().replace(tzinfo=None, microsecond=0).isoformat(timespec='seconds')


def today_str():
    """Local calendar date as YYYY-MM-DD."""
    return now_local().strftime('%Y-%m-%d')
