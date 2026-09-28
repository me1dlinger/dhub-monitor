"""Docker Hub v2 API client.

Design goals:
  * never hang forever (explicit connect/read timeouts),
  * back off and retry on 429/5xx instead of failing the whole refresh,
  * distinguish "repository does not exist" (404) from transient failures,
  * be safe to call from multiple worker threads (one session per thread).
"""

import logging
import threading
import time

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from config import DOCKER_HUB_API, DOCKER_HUB_TOKEN, REQUEST_TIMEOUT, TAGS_CACHE_TTL

logger = logging.getLogger(__name__)

HUB_API = DOCKER_HUB_API
USER_AGENT = 'docker-hub-monitor/2.0 (self-hosted)'

_local = threading.local()
_tags_cache = {}
_tags_lock = threading.Lock()


class RepoNotFound(Exception):
    """The repository does not exist on Docker Hub."""


class RepoFetchError(Exception):
    """A transient or unexpected failure while talking to Docker Hub."""


def _build_session():
    session = requests.Session()
    retry = Retry(
        total=3,
        connect=3,
        read=3,
        status=3,
        backoff_factor=1.2,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({'GET'}),
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=8, pool_maxsize=8)
    session.mount('https://', adapter)
    session.mount('http://', adapter)
    session.headers.update({'User-Agent': USER_AGENT, 'Accept': 'application/json'})
    if DOCKER_HUB_TOKEN:
        session.headers['Authorization'] = f'Bearer {DOCKER_HUB_TOKEN}'
    return session


def _session():
    session = getattr(_local, 'session', None)
    if session is None:
        session = _build_session()
        _local.session = session
    return session


def _get(url):
    session = _session()
    try:
        response = session.get(url, timeout=(5, REQUEST_TIMEOUT))
        # A rejected token must not break public repositories: retry anonymously.
        if response.status_code in (401, 403) and DOCKER_HUB_TOKEN:
            response = session.get(url, timeout=(5, REQUEST_TIMEOUT),
                                   headers={'Authorization': None})
        return response
    except requests.exceptions.RequestException as exc:
        raise RepoFetchError(str(exc)) from exc


def _as_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def fetch_repo(namespace, name):
    """Fetch repository metadata.

    Raises RepoNotFound when Docker Hub reports 404, RepoFetchError otherwise.
    """
    response = _get(f'{HUB_API}/{namespace}/{name}')
    if response.status_code == 404:
        raise RepoNotFound(f'{namespace}/{name} not found')
    if response.status_code >= 400:
        raise RepoFetchError(f'HTTP {response.status_code}')
    try:
        data = response.json()
    except ValueError as exc:
        raise RepoFetchError('invalid JSON response') from exc
    return {
        'pull_count': _as_int(data.get('pull_count')),
        'last_updated': data.get('last_updated') or '',
        'name': data.get('name') or name,
        'namespace': data.get('namespace') or namespace,
    }


def fetch_repo_tags(namespace, name, page_size=50):
    response = _get(f'{HUB_API}/{namespace}/{name}/tags?page_size={page_size}')
    if response.status_code == 404:
        raise RepoNotFound(f'{namespace}/{name} not found')
    if response.status_code >= 400:
        raise RepoFetchError(f'HTTP {response.status_code}')
    try:
        data = response.json()
    except ValueError as exc:
        raise RepoFetchError('invalid JSON response') from exc
    tags = []
    for item in data.get('results') or []:
        tags.append({
            'name': item.get('name') or '',
            'last_updated': item.get('last_updated') or '',
            'tag_last_pushed': item.get('tag_last_pushed') or '',
            'tag_last_pulled': item.get('tag_last_pulled') or '',
            'status': item.get('tag_status') or '',
        })
    return tags


def get_tags(namespace, name, force=False):
    """Return (tags, cached_at). Serves stale data when a refresh fails."""
    key = f'{namespace}/{name}'
    now = time.time()
    with _tags_lock:
        cached = _tags_cache.get(key)

    if cached and not force and (now - cached['cached_at']) < TAGS_CACHE_TTL:
        return cached['tags'], cached['cached_at']

    try:
        tags = fetch_repo_tags(namespace, name)
    except (RepoFetchError, RepoNotFound) as exc:
        logger.warning('tag refresh failed for %s: %s', key, exc)
        if cached:
            return cached['tags'], cached['cached_at']
        return None, None

    with _tags_lock:
        _tags_cache[key] = {'tags': tags, 'cached_at': now}
    return tags, now


def check_repo_exists(namespace, name):
    """True when the repo exists. Raises RepoFetchError on network failure."""
    try:
        fetch_repo(namespace, name)
        return True
    except RepoNotFound:
        return False
