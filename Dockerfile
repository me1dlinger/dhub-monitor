FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    TZ=Asia/Shanghai

# tzdata is required for zoneinfo on the slim image; supervisor keeps the web
# and scheduler processes alive independently.
RUN apt-get update \
    && apt-get install -y --no-install-recommends supervisor tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime

WORKDIR /app/python

COPY python/requirements.txt /app/python/requirements.txt
RUN pip install --no-cache-dir -r /app/python/requirements.txt

COPY python /app/python
COPY conf/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Run as an unprivileged user. The data directory must be writable by UID
# 1000; when the project is bind-mounted, ensure its ownership matches.
RUN mkdir -p /app/python/data \
    && useradd --uid 1000 --create-home --shell /usr/sbin/nologin app \
    && chown -R app:app /app
USER app

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:5000/api/health', timeout=4).status == 200 else 1)"

CMD ["supervisord", "-n", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
