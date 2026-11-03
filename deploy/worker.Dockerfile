# Build context is the repository root.
FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1
ENV CONFIG_DIR=/app/config
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY config ./config
COPY apps/worker ./apps/worker
RUN pip install ./apps/worker \
 && apt-get update \
 && apt-get purge -y git \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin app \
 && chown -R app:app /app
USER app
WORKDIR /app/apps/worker
CMD ["python", "-m", "sentiment_monitor.scheduler"]
