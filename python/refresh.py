"""Refresh orchestration, shared by the web process and the scheduler process.

Only one refresh may run at a time regardless of which process triggers it;
concurrency is bounded by a file lock plus a thread pool for the HTTP fetches.
"""

import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from config import FETCH_WORKERS, LOCK_PATH, REFRESH_INTERVAL_HOURS, iso_now, now_local
from database import (
    add_refresh_log,
    get_images,
    record_stat,
    set_state,
    update_refresh_log,
)
from docker_service import RepoFetchError, RepoNotFound, fetch_repo
from lock import FileLock

logger = logging.getLogger(__name__)


def refresh_image(image_id, namespace, name):
    """Refresh a single repository. Never raises; returns a result dict."""
    label = f'{namespace}/{name}'
    try:
        data = fetch_repo(namespace, name)
    except RepoNotFound:
        return {'image': label, 'success': False, 'error': 'not_found'}
    except RepoFetchError as exc:
        return {'image': label, 'success': False, 'error': str(exc)}

    try:
        stat = record_stat(
            image_id,
            pulls_total=data['pull_count'],
            last_updated=data['last_updated'],
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception('failed to store stat for %s', label)
        return {'image': label, 'success': False, 'error': f'db_error: {exc}'}

    if stat is None:
        return {'image': label, 'success': True, 'pulls_total': 0,
                'pulls_per_day': 0, 'note': 'no_data'}

    return {
        'image': label,
        'success': True,
        'pulls_total': stat['pulls_total'],
        'pulls_per_day': stat['pulls_per_day'],
        'clamped': stat['clamped'],
    }


def refresh_all_images():
    images = get_images()
    if not images:
        return []

    results = []
    workers = max(1, min(FETCH_WORKERS, len(images)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(refresh_image, img['id'], img['namespace'], img['name']): img
            for img in images
        }
        for future in as_completed(futures):
            img = futures[future]
            try:
                results.append(future.result())
            except Exception as exc:  # pragma: no cover - defensive
                logger.exception('unexpected refresh failure')
                results.append({
                    'image': f"{img['namespace']}/{img['name']}",
                    'success': False,
                    'error': str(exc),
                })
    return results


def run_refresh(source='scheduled'):
    """Run a full refresh guarded by the cross-process lock."""
    lock = FileLock(LOCK_PATH, stale_seconds=max(1800, REFRESH_INTERVAL_HOURS * 3600))
    if not lock.acquire():
        logger.info('%s refresh skipped: another refresh is running', source)
        return {'status': 'skipped', 'reason': 'refresh_in_progress'}

    try:
        started_at = iso_now()
        log_id = add_refresh_log(started_at, source)
        began = time.time()
        results = refresh_all_images()
        duration_ms = int((time.time() - began) * 1000)

        total = len(results)
        success = sum(1 for item in results if item['success'])
        failed = total - success
        if total == 0:
            status = 'success'
        elif failed == 0:
            status = 'success'
        elif success > 0:
            status = 'partial'
        else:
            status = 'failed'

        completed_at = iso_now()
        update_refresh_log(
            log_id, completed_at, status, total, success, failed,
            duration_ms, json.dumps(results, ensure_ascii=False),
        )
        set_state('last_refresh_at', completed_at)
        set_state('last_refresh_status', status)

        logger.info(
            '%s refresh finished: status=%s success=%s/%s in %sms',
            source, status, success, total, duration_ms,
        )
        return {
            'status': status,
            'total': total,
            'success': success,
            'failed': failed,
            'duration_ms': duration_ms,
            'details': results,
        }
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception('%s refresh crashed', source)
        set_state('last_refresh_status', 'failed')
        return {'status': 'failed', 'reason': str(exc)}
    finally:
        lock.release()
