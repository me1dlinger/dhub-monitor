"""Docker Hub Monitor - Flask web application.

The web process only serves the UI and the JSON API. Periodic collection runs
in a separate scheduler process (see ``scheduler.py``); both share the SQLite
database and a cross-process lock so a manual refresh can never overlap a
scheduled one.
"""

import functools
import hashlib
import hmac
import logging
import os
import re
import threading
import time
from datetime import datetime

from flask import Flask, jsonify, render_template, request

from config import (
    APP_NAME,
    AUTH_SECRET,
    BASE_DIR,
    DEFAULT_DAYS,
    EMBEDDED_SCHEDULER,
    LOCAL_TZ,
    LOGIN_LOCKOUT_SECONDS,
    LOGIN_MAX_ATTEMPTS,
    REFRESH_INTERVAL_HOURS,
    now_local,
)
from database import (
    add_image,
    get_all_history,
    get_image,
    get_images_with_latest,
    get_latest_stat,
    get_refresh_logs,
    get_state,
    init_db,
    record_stat,
    remove_image,
)
from docker_service import (
    RepoFetchError,
    RepoNotFound,
    fetch_repo,
    get_tags,
)
from refresh import refresh_image, run_refresh

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s [web] %(message)s')
logger = logging.getLogger(__name__)

auth_enabled = bool(AUTH_SECRET)

_REPO_PART_RE = re.compile(r'^[a-z0-9][a-z0-9._-]{0,99}$')
_CONTROL_CHARS_RE = re.compile(r'[\x00-\x1f\x7f]')
_SCHEDULER_STALE_SECONDS = 180


def _asset_version():
    parts = []
    for rel in ('css/style.css', 'js/theme.js', 'js/common.js',
                'js/dashboard.js', 'js/manage.js', 'js/logs.js'):
        path = os.path.join(BASE_DIR, 'static', *rel.split('/'))
        try:
            parts.append(f'{rel}:{os.path.getmtime(path)}')
        except OSError:
            pass
    return hashlib.md5('|'.join(parts).encode('utf-8')).hexdigest()[:8]


ASSET_VERSION = _asset_version()


class LoginThrottle:
    """Simple in-memory per-IP failure counter to slow down brute force."""

    def __init__(self, max_attempts, lockout_seconds):
        self.max_attempts = max_attempts
        self.lockout_seconds = lockout_seconds
        self._failures = {}
        self._lock = threading.Lock()

    def _prune(self, ip, now):
        times = [t for t in self._failures.get(ip, []) if now - t < self.lockout_seconds]
        if times:
            self._failures[ip] = times
        else:
            self._failures.pop(ip, None)
        return times

    def blocked_for(self, ip):
        now = time.time()
        with self._lock:
            times = self._prune(ip, now)
            if len(times) >= self.max_attempts:
                return int(self.lockout_seconds - (now - times[0])) + 1
            return 0

    def register_failure(self, ip):
        now = time.time()
        with self._lock:
            times = self._prune(ip, now)
            times.append(now)
            self._failures[ip] = times

    def reset(self, ip):
        with self._lock:
            self._failures.pop(ip, None)


throttle = LoginThrottle(LOGIN_MAX_ATTEMPTS, LOGIN_LOCKOUT_SECONDS)

app = Flask(__name__)
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 3600
app.config['JSON_SORT_KEYS'] = False
app.config['MAX_CONTENT_LENGTH'] = 256 * 1024

init_db()

if EMBEDDED_SCHEDULER:
    from apscheduler.schedulers.background import BackgroundScheduler

    from scheduling import configure as configure_scheduler

    _embedded_scheduler = BackgroundScheduler(timezone=LOCAL_TZ)
    configure_scheduler(_embedded_scheduler)
    _embedded_scheduler.start()
    logger.info(
        'embedded scheduler started (every %sh); set EMBEDDED_SCHEDULER=false '
        'when running the dedicated scheduler', REFRESH_INTERVAL_HOURS,
    )


# --------------------------------------------------------------------------- #
# Auth helpers
# --------------------------------------------------------------------------- #
def _extract_token():
    header = request.headers.get('Authorization', '')
    if header.startswith('Bearer '):
        return header[7:].strip()
    return ''


def _token_valid(token):
    return bool(token) and hmac.compare_digest(token, AUTH_SECRET)


def require_auth(view):
    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        if not auth_enabled:
            return view(*args, **kwargs)
        if not _token_valid(_extract_token()):
            return jsonify({'error': 'unauthorized'}), 401
        return view(*args, **kwargs)

    return wrapper


def _client_ip():
    return request.remote_addr or 'unknown'


# --------------------------------------------------------------------------- #
# Validation helpers
# --------------------------------------------------------------------------- #
def _clean_repo_part(value):
    value = (value or '').strip().lower()
    return value if _REPO_PART_RE.match(value) else None


def _clean_display_name(value):
    value = _CONTROL_CHARS_RE.sub('', (value or '').strip())
    return value[:80] or None


# --------------------------------------------------------------------------- #
# Scheduling status
# --------------------------------------------------------------------------- #
def _scheduler_status():
    heartbeat = get_state('scheduler_heartbeat')
    online = False
    if heartbeat:
        try:
            delta = (now_local().replace(tzinfo=None) - datetime.fromisoformat(heartbeat)).total_seconds()
            online = 0 <= delta <= _SCHEDULER_STALE_SECONDS
        except ValueError:
            online = False
    return {
        'scheduler_online': online,
        'scheduler_heartbeat': heartbeat,
        'refresh_interval_hours': REFRESH_INTERVAL_HOURS,
    }


# --------------------------------------------------------------------------- #
# Security headers
# --------------------------------------------------------------------------- #
@app.after_request
def apply_security_headers(response):
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'DENY')
    response.headers.setdefault('Referrer-Policy', 'no-referrer')
    response.headers.setdefault('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')
    response.headers.setdefault('Cross-Origin-Opener-Policy', 'same-origin')
    response.headers['Content-Security-Policy'] = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; "
        "font-src 'self'; "
        "connect-src 'self'; "
        "object-src 'none'; "
        "base-uri 'none'; "
        "frame-ancestors 'none'; "
        "form-action 'self'"
    )
    if request.path.startswith('/api/') or request.path in ('/', '/manage', '/logs'):
        response.headers['Cache-Control'] = 'no-store'
    return response


@app.context_processor
def inject_globals():
    return {
        'app_name': APP_NAME,
        'auth_enabled': auth_enabled,
        'default_days': DEFAULT_DAYS,
        'asset_version': ASSET_VERSION,
    }


# --------------------------------------------------------------------------- #
# Pages
# --------------------------------------------------------------------------- #
@app.route('/')
def dashboard():
    return render_template('dashboard.html', active_page='dashboard')


@app.route('/manage')
def manage():
    return render_template('manage.html', active_page='manage')


@app.route('/logs')
def logs_page():
    return render_template('logs.html', active_page='logs')


# --------------------------------------------------------------------------- #
# Auth API
# --------------------------------------------------------------------------- #
@app.route('/api/auth/login', methods=['POST'])
def api_auth_login():
    if not auth_enabled:
        return jsonify({'error': 'auth_disabled'}), 400

    ip = _client_ip()
    retry_after = throttle.blocked_for(ip)
    if retry_after > 0:
        response = jsonify({'error': 'too_many_attempts', 'retry_after': retry_after})
        response.status_code = 429
        response.headers['Retry-After'] = str(retry_after)
        return response

    data = request.get_json(silent=True) or {}
    key = str(data.get('key', '')).strip()
    if key and hmac.compare_digest(key, AUTH_SECRET):
        throttle.reset(ip)
        return jsonify({'token': AUTH_SECRET})

    throttle.register_failure(ip)
    return jsonify({'error': 'invalid_credentials'}), 401


@app.route('/api/auth/verify', methods=['POST'])
def api_auth_verify():
    if not auth_enabled:
        return jsonify({'valid': True})
    data = request.get_json(silent=True) or {}
    token = str(data.get('token', '')).strip()
    if _token_valid(token):
        return jsonify({'valid': True})
    return jsonify({'valid': False}), 401


# --------------------------------------------------------------------------- #
# Health
# --------------------------------------------------------------------------- #
@app.route('/api/health')
def api_health():
    return jsonify({
        'status': 'ok',
        'auth_enabled': auth_enabled,
        'last_refresh_at': get_state('last_refresh_at'),
        'last_refresh_status': get_state('last_refresh_status'),
        **_scheduler_status(),
    })


# --------------------------------------------------------------------------- #
# Overview / images
# --------------------------------------------------------------------------- #
def _window_daily_rate(series):
    """Average daily pull increase across an image's observed window.

    ``series`` is an ordered list of ``{'date', 'pulls_total', ...}`` rows.
    The rate is ``(last total - first total) / observed day span`` so missed
    refreshes never distort it. Returns ``None`` when fewer than two distinct
    days are observed, letting callers fall back to the latest normalised rate.
    """
    if len(series) < 2:
        return None
    try:
        first = datetime.strptime(series[0]['date'], '%Y-%m-%d')
        last = datetime.strptime(series[-1]['date'], '%Y-%m-%d')
    except (KeyError, TypeError, ValueError):
        return None
    span = (last - first).days
    if span <= 0:
        return None
    gain = (series[-1].get('pulls_total') or 0) - (series[0].get('pulls_total') or 0)
    return max(0.0, gain / span)


def _history_rate_map(days):
    """``{image_id: average daily rate}`` over the last ``days`` days."""
    grouped = {}
    for row in get_all_history(days):
        grouped.setdefault(row['image_id'], []).append(row)
    return {image_id: _window_daily_rate(rows) for image_id, rows in grouped.items()}


@app.route('/api/overview')
@require_auth
def api_overview():
    days = request.args.get('days', DEFAULT_DAYS, type=int) or DEFAULT_DAYS
    days = max(1, min(365, days))

    images = get_images_with_latest()
    series_by_image = {}
    for row in get_all_history(days):
        series_by_image.setdefault(row['image_id'], []).append({
            'date': row['date'],
            'pulls_total': row['pulls_total'],
            'pulls_per_day': row['pulls_per_day'],
        })

    total_pulls = 0
    avg_pulls_per_day = 0.0
    payload_images = []

    for img in images:
        series = series_by_image.get(img['id'], [])
        rate = _window_daily_rate(series)

        latest = None
        if img.get('date'):
            latest = {
                'date': img['date'],
                'pulls_total': img['pulls_total'] or 0,
                'pulls_delta': img['pulls_delta'] or 0,
                'pulls_per_day': img['pulls_per_day'] or 0,
                'gap_days': img['gap_days'] or 0,
                'last_updated': img['last_updated'],
                'captured_at': img['captured_at'],
            }
            if rate is None:
                rate = latest['pulls_per_day']
            latest['avg_pulls_per_day'] = int(round(rate))
            total_pulls += latest['pulls_total']
            avg_pulls_per_day += rate

        payload_images.append({
            'id': img['id'],
            'display_name': img['display_name'],
            'namespace': img['namespace'],
            'name': img['name'],
            'latest': latest,
            'series': series,
        })

    return jsonify({
        'days': days,
        'summary': {
            'total_pulls': total_pulls,
            'avg_pulls_per_day': int(round(avg_pulls_per_day)),
            'image_count': len(images),
            'last_refresh_at': get_state('last_refresh_at'),
            'last_refresh_status': get_state('last_refresh_status'),
            **_scheduler_status(),
        },
        'images': payload_images,
    })


@app.route('/api/images', methods=['GET'])
@require_auth
def api_get_images():
    rates = _history_rate_map(DEFAULT_DAYS)
    result = []
    for img in get_images_with_latest():
        latest = None
        if img.get('date'):
            latest = {
                'date': img['date'],
                'pulls_total': img['pulls_total'] or 0,
                'pulls_per_day': img['pulls_per_day'] or 0,
                'pulls_delta': img['pulls_delta'] or 0,
                'gap_days': img['gap_days'] or 0,
                'last_updated': img['last_updated'],
                'captured_at': img['captured_at'],
            }
            rate = rates.get(img['id'])
            if rate is None:
                rate = latest['pulls_per_day']
            latest['avg_pulls_per_day'] = int(round(rate))
        result.append({
            'id': img['id'],
            'display_name': img['display_name'],
            'namespace': img['namespace'],
            'name': img['name'],
            'latest': latest,
        })
    return jsonify(result)


@app.route('/api/images', methods=['POST'])
@require_auth
def api_add_image():
    data = request.get_json(silent=True) or {}
    namespace = _clean_repo_part(data.get('namespace'))
    name = _clean_repo_part(data.get('name'))
    display_name = _clean_display_name(data.get('display_name'))

    if not namespace or not name:
        return jsonify({'error': 'invalid_repository', 'message': '命名空间或仓库名格式不正确'}), 400

    try:
        repo = fetch_repo(namespace, name)
    except RepoNotFound:
        return jsonify({'error': 'not_found', 'message': f'{namespace}/{name} 在 Docker Hub 上不存在'}), 404
    except RepoFetchError:
        return jsonify({'error': 'upstream_unavailable', 'message': '暂时无法连接 Docker Hub，请稍后重试'}), 502

    image_id = add_image(namespace, name, display_name)
    if image_id is None:
        return jsonify({'error': 'already_exists', 'message': f'{namespace}/{name} 已在监控列表中'}), 409

    record_stat(image_id, repo['pull_count'], last_updated=repo['last_updated'])
    return jsonify({'id': image_id, 'message': '镜像添加成功'}), 201


@app.route('/api/images/<int:image_id>', methods=['DELETE'])
@require_auth
def api_delete_image(image_id):
    if not get_image(image_id):
        return jsonify({'error': 'not_found'}), 404
    remove_image(image_id)
    return jsonify({'message': '镜像已移除'})


@app.route('/api/images/<int:image_id>/refresh', methods=['POST'])
@require_auth
def api_refresh_image(image_id):
    img = get_image(image_id)
    if not img:
        return jsonify({'error': 'not_found'}), 404
    result = refresh_image(img['id'], img['namespace'], img['name'])
    if not result['success']:
        return jsonify({'error': 'refresh_failed', 'message': result.get('error', '刷新失败')}), 502
    return jsonify({
        'success': True,
        'latest': get_latest_stat(image_id),
    })


@app.route('/api/images/<int:image_id>/tags', methods=['GET'])
@require_auth
def api_image_tags(image_id):
    img = get_image(image_id)
    if not img:
        return jsonify({'error': 'not_found'}), 404
    force = request.args.get('force', '0') == '1'
    tags, cached_at = get_tags(img['namespace'], img['name'], force=force)
    if tags is None:
        return jsonify({'error': 'upstream_unavailable', 'message': '无法获取版本信息'}), 502
    return jsonify({'tags': tags, 'cached_at': cached_at})


# --------------------------------------------------------------------------- #
# Refresh & logs
# --------------------------------------------------------------------------- #
@app.route('/api/refresh', methods=['POST'])
@require_auth
def api_refresh():
    result = run_refresh('manual')
    if result.get('status') == 'skipped':
        return jsonify({'error': 'refresh_in_progress', 'message': '已有刷新任务正在运行'}), 409
    return jsonify(result)


@app.route('/api/logs', methods=['GET'])
@require_auth
def api_logs():
    limit = request.args.get('limit', 50, type=int) or 50
    return jsonify(get_refresh_logs(max(1, min(200, limit))))


# --------------------------------------------------------------------------- #
# Error handlers
# --------------------------------------------------------------------------- #
@app.errorhandler(404)
def handle_404(_error):
    if request.path.startswith('/api/'):
        return jsonify({'error': 'not_found'}), 404
    return render_template('dashboard.html', active_page='dashboard'), 404


@app.errorhandler(413)
def handle_413(_error):
    return jsonify({'error': 'payload_too_large'}), 413


@app.errorhandler(Exception)
def handle_unexpected(error):
    logger.exception('unhandled error on %s', request.path)
    if request.path.startswith('/api/'):
        return jsonify({'error': 'internal_error'}), 500
    return jsonify({'error': 'internal_error'}), 500


if __name__ == '__main__':
    from config import HOST, PORT

    app.run(host=HOST, port=PORT, debug=False, threaded=True)
