"""SQLite persistence layer.

Metric model
------------
Docker Hub only exposes a cumulative ``pull_count``. A naive "today minus
yesterday" approach produces huge fake spikes whenever a refresh is missed, so
we store, for every local calendar day, the *last observed* cumulative total and
derive:

    pulls_delta    cumulative total gained since the previous observed day
    gap_days       number of days since the previous observed day (0 = baseline)
    pulls_per_day  pulls_delta / max(gap_days, 1)   (normalised daily rate)

This stays correct across missed days and for brand new repositories (whose
first row is a baseline with ``gap_days = 0``).
"""

import os
import sqlite3
from datetime import datetime, timedelta

from config import DATA_DIR, DB_PATH, iso_now, now_local, today_str


def get_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA synchronous=NORMAL')
    conn.execute('PRAGMA foreign_keys=ON')
    conn.execute('PRAGMA busy_timeout=15000')
    return conn


def init_db():
    conn = get_db()
    try:
        with conn:
            conn.executescript(
                '''
                CREATE TABLE IF NOT EXISTS images (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    namespace TEXT NOT NULL,
                    name TEXT NOT NULL,
                    display_name TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    active INTEGER NOT NULL DEFAULT 1,
                    UNIQUE(namespace, name)
                );

                CREATE TABLE IF NOT EXISTS pull_stats (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    image_id INTEGER NOT NULL,
                    date TEXT NOT NULL,
                    pulls_total INTEGER NOT NULL DEFAULT 0,
                    pulls_delta INTEGER NOT NULL DEFAULT 0,
                    gap_days INTEGER NOT NULL DEFAULT 0,
                    pulls_per_day INTEGER NOT NULL DEFAULT 0,
                    stars_total INTEGER NOT NULL DEFAULT 0,
                    last_updated TEXT,
                    captured_at TEXT,
                    FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE,
                    UNIQUE(image_id, date)
                );

                CREATE TABLE IF NOT EXISTS refresh_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    started_at TEXT NOT NULL,
                    completed_at TEXT,
                    source TEXT NOT NULL DEFAULT 'scheduled',
                    status TEXT NOT NULL DEFAULT 'running',
                    total_images INTEGER DEFAULT 0,
                    success_count INTEGER DEFAULT 0,
                    fail_count INTEGER DEFAULT 0,
                    duration_ms INTEGER DEFAULT 0,
                    details TEXT
                );

                CREATE TABLE IF NOT EXISTS runtime_state (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_pull_stats_image_date
                    ON pull_stats (image_id, date);
                '''
            )
        repair_pull_stats()
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# Images
# --------------------------------------------------------------------------- #
def add_image(namespace, name, display_name=None):
    conn = get_db()
    try:
        with conn:
            cursor = conn.execute(
                'INSERT INTO images (namespace, name, display_name) VALUES (?, ?, ?)',
                (namespace, name, display_name or f'{namespace}/{name}'),
            )
            return cursor.lastrowid
    except sqlite3.IntegrityError:
        return None
    finally:
        conn.close()


def remove_image(image_id):
    conn = get_db()
    try:
        with conn:
            conn.execute('DELETE FROM pull_stats WHERE image_id = ?', (image_id,))
            cursor = conn.execute('DELETE FROM images WHERE id = ?', (image_id,))
            return cursor.rowcount > 0
    finally:
        conn.close()


def get_images():
    conn = get_db()
    try:
        rows = conn.execute(
            'SELECT * FROM images WHERE active = 1 ORDER BY display_name COLLATE NOCASE'
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def get_image(image_id):
    conn = get_db()
    try:
        row = conn.execute('SELECT * FROM images WHERE id = ?', (image_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_images_with_latest():
    """Images plus their most recent stat, in a single query (no N+1)."""
    conn = get_db()
    try:
        rows = conn.execute(
            '''
            SELECT i.id, i.namespace, i.name, i.display_name, i.created_at,
                   ps.date, ps.pulls_total, ps.pulls_delta, ps.pulls_per_day,
                   ps.gap_days, ps.last_updated, ps.captured_at
            FROM images i
            LEFT JOIN pull_stats ps ON ps.id = (
                SELECT id FROM pull_stats WHERE image_id = i.id ORDER BY date DESC LIMIT 1
            )
            WHERE i.active = 1
            ORDER BY i.display_name COLLATE NOCASE
            '''
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# Stats
# --------------------------------------------------------------------------- #
def record_stat(image_id, pulls_total, last_updated=None):
    """Upsert today's row, enforcing that pull counts never decrease.

    Docker Hub pull counts only go up, so a reported value of zero (or below
    the highest total we have already confirmed) is treated as a bad reading:
    the last confirmed value is carried forward instead of being stored.
    """
    today = today_str()
    reported = int(pulls_total or 0)
    conn = get_db()
    try:
        with conn:
            summary = conn.execute(
                '''SELECT COUNT(*) AS rows, COALESCE(MAX(pulls_total), 0) AS floor
                   FROM pull_stats WHERE image_id = ?''',
                (image_id,),
            ).fetchone()
            has_history = summary['rows'] > 0
            floor = summary['floor'] or 0

            if not has_history and reported <= 0:
                # No trustworthy value yet; do not create a bogus baseline.
                return None

            effective = reported if reported > floor else floor

            prev = conn.execute(
                '''SELECT date, pulls_total FROM pull_stats
                   WHERE image_id = ? AND date < ?
                   ORDER BY date DESC LIMIT 1''',
                (image_id, today),
            ).fetchone()

            if prev:
                try:
                    gap_days = max(1, (datetime.strptime(today, '%Y-%m-%d')
                                       - datetime.strptime(prev['date'], '%Y-%m-%d')).days)
                except ValueError:
                    gap_days = 1
                delta = max(0, effective - (prev['pulls_total'] or 0))
                per_day = int(round(delta / gap_days))
            else:
                gap_days = 0
                delta = 0
                per_day = 0

            conn.execute(
                '''
                INSERT INTO pull_stats
                    (image_id, date, pulls_total, pulls_delta, gap_days,
                     pulls_per_day, last_updated, captured_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(image_id, date) DO UPDATE SET
                    pulls_total = excluded.pulls_total,
                    pulls_delta = excluded.pulls_delta,
                    gap_days = excluded.gap_days,
                    pulls_per_day = excluded.pulls_per_day,
                    last_updated = excluded.last_updated,
                    captured_at = excluded.captured_at
                ''',
                (image_id, today, effective, delta, gap_days,
                 per_day, last_updated, iso_now()),
            )
            return {
                'date': today,
                'pulls_total': effective,
                'pulls_delta': delta,
                'gap_days': gap_days,
                'pulls_per_day': per_day,
                'clamped': effective != reported,
            }
    finally:
        conn.close()


def repair_pull_stats():
    """Rewrite history so pull counts are monotonic and derived values match.

    Runs on every startup. It carries the running maximum forward for any row
    that recorded a decrease or zero, then recomputes ``pulls_delta``,
    ``gap_days`` and ``pulls_per_day`` for the whole series.
    """
    conn = get_db()
    try:
        with conn:
            image_ids = [row['image_id'] for row in
                         conn.execute('SELECT DISTINCT image_id FROM pull_stats')]
            for image_id in image_ids:
                rows = conn.execute(
                    '''SELECT id, date, pulls_total FROM pull_stats
                       WHERE image_id = ? ORDER BY date ASC''',
                    (image_id,),
                ).fetchall()

                running = None
                previous_date = None
                previous_total = None
                for row in rows:
                    total = int(row['pulls_total'] or 0)
                    if running is None:
                        running = total
                    elif total < running:
                        total = running
                    else:
                        running = total

                    if previous_date is None:
                        gap_days = 0
                        delta = 0
                        per_day = 0
                    else:
                        try:
                            gap_days = max(1, (datetime.strptime(row['date'], '%Y-%m-%d')
                                               - datetime.strptime(previous_date, '%Y-%m-%d')).days)
                        except ValueError:
                            gap_days = 1
                        delta = max(0, total - previous_total)
                        per_day = int(round(delta / gap_days))

                    conn.execute(
                        '''UPDATE pull_stats
                           SET pulls_total = ?, pulls_delta = ?, gap_days = ?, pulls_per_day = ?
                           WHERE id = ?''',
                        (total, delta, gap_days, per_day, row['id']),
                    )
                    previous_date = row['date']
                    previous_total = total
    finally:
        conn.close()


def get_latest_stat(image_id):
    conn = get_db()
    try:
        row = conn.execute(
            '''SELECT id, image_id, date, pulls_total, pulls_delta, gap_days,
                      pulls_per_day, last_updated, captured_at
               FROM pull_stats WHERE image_id = ? ORDER BY date DESC LIMIT 1''',
            (image_id,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_image_history(image_id, days=30):
    cutoff = (now_local().date() - timedelta(days=int(days))).strftime('%Y-%m-%d')
    conn = get_db()
    try:
        rows = conn.execute(
            '''SELECT date, pulls_total, pulls_delta, pulls_per_day
               FROM pull_stats
               WHERE image_id = ? AND date >= ?
               ORDER BY date ASC''',
            (image_id, cutoff),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def get_all_history(days=30):
    """Every image's history in one query, for the overview charts (no N+1)."""
    cutoff = (now_local().date() - timedelta(days=int(days))).strftime('%Y-%m-%d')
    conn = get_db()
    try:
        rows = conn.execute(
            '''SELECT image_id, date, pulls_total, pulls_delta, pulls_per_day
               FROM pull_stats
               WHERE date >= ?
               ORDER BY image_id ASC, date ASC''',
            (cutoff,),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# Logs & runtime state
# --------------------------------------------------------------------------- #
def add_refresh_log(started_at, source='scheduled'):
    conn = get_db()
    try:
        with conn:
            cursor = conn.execute(
                'INSERT INTO refresh_logs (started_at, source, status) VALUES (?, ?, ?)',
                (started_at, source, 'running'),
            )
            return cursor.lastrowid
    finally:
        conn.close()


def update_refresh_log(log_id, completed_at, status, total_images,
                       success_count, fail_count, duration_ms=0, details=None):
    conn = get_db()
    try:
        with conn:
            conn.execute(
                '''UPDATE refresh_logs
                   SET completed_at = ?, status = ?, total_images = ?,
                       success_count = ?, fail_count = ?, duration_ms = ?, details = ?
                   WHERE id = ?''',
                (completed_at, status, total_images, success_count,
                 fail_count, duration_ms, details, log_id),
            )
    finally:
        conn.close()


def get_refresh_logs(limit=50):
    conn = get_db()
    try:
        rows = conn.execute(
            'SELECT * FROM refresh_logs ORDER BY started_at DESC, id DESC LIMIT ?',
            (int(limit),),
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def set_state(key, value):
    conn = get_db()
    try:
        with conn:
            conn.execute(
                '''INSERT INTO runtime_state (key, value, updated_at)
                   VALUES (?, ?, ?)
                   ON CONFLICT(key) DO UPDATE SET
                       value = excluded.value, updated_at = excluded.updated_at''',
                (key, str(value), iso_now()),
            )
    finally:
        conn.close()


def get_state(key, default=None):
    conn = get_db()
    try:
        row = conn.execute('SELECT value FROM runtime_state WHERE key = ?', (key,)).fetchone()
        return row['value'] if row else default
    finally:
        conn.close()


def get_states():
    conn = get_db()
    try:
        rows = conn.execute('SELECT key, value, updated_at FROM runtime_state').fetchall()
        return {row['key']: {'value': row['value'], 'updated_at': row['updated_at']} for row in rows}
    finally:
        conn.close()
