"""A tiny cross-platform advisory lock.

Used to make sure only one refresh runs at a time even though the web process
and the scheduler process are separate processes. Implemented with atomic file
creation (O_CREAT | O_EXCL) so it works on Linux and Windows alike, unlike
fcntl/msvcrt based locks.
"""

import os
import time
import uuid


class FileLock:
    def __init__(self, path, stale_seconds=3600):
        self.path = path
        self.stale_seconds = max(60, int(stale_seconds))
        self.acquired = False

    def _is_stale(self):
        try:
            mtime = os.path.getmtime(self.path)
        except OSError:
            return False
        return (time.time() - mtime) > self.stale_seconds

    def acquire(self):
        directory = os.path.dirname(self.path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        # One retry: a stale lock file from a crashed process may be removed.
        for _ in range(2):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                if self._is_stale():
                    try:
                        os.remove(self.path)
                    except OSError:
                        pass
                    continue
                return False
            try:
                os.write(fd, f'{os.getpid()} {time.time()} {uuid.uuid4().hex}'.encode('ascii'))
            finally:
                os.close(fd)
            self.acquired = True
            return True
        return False

    def release(self):
        if not self.acquired:
            return
        self.acquired = False
        try:
            os.remove(self.path)
        except OSError:
            pass

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *exc_info):
        self.release()
        return False
