# syntax=docker/dockerfile:1
FROM node:24.15.0-bookworm-slim AS frontend
WORKDIR /build
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY apps/web apps/web
RUN npm run build --workspace @tongpin/web

FROM python:3.12.13-slim-bookworm AS runtime
COPY --from=ghcr.io/astral-sh/uv:0.11.27 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never PYTHONUTF8=1 PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY pyproject.toml uv.lock .python-version ./
COPY src src
RUN uv sync --locked --no-dev --python /usr/local/bin/python && rm -rf /root/.cache/uv
COPY scripts scripts
COPY LICENSE THIRD_PARTY_NOTICES.md ./
COPY vendor/unicode/17.0/LICENSE-UNICODE.txt vendor/unicode/17.0/LICENSE-UNICODE.txt
COPY --from=frontend /build/apps/web/dist apps/web/dist
RUN groupadd --gid 10001 tongpin && useradd --uid 10001 --gid tongpin --no-create-home tongpin && mkdir /persistent && chown tongpin:tongpin /persistent
USER 10001:10001
ENV TONGPIN_HOST=0.0.0.0 TONGPIN_PORT=8765 TONGPIN_DATA_DIR=/persistent
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["/app/.venv/bin/python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/health/ready', timeout=3)"]
ENTRYPOINT ["/app/.venv/bin/python", "/app/scripts/deploy.py"]
CMD ["run"]
