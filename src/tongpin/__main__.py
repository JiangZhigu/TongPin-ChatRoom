from __future__ import annotations

import argparse

import uvicorn

from tongpin import __version__
from tongpin.asgi import create_application
from tongpin.config import Settings


def main():
    parser = argparse.ArgumentParser(description="Tongpin persistent Flask/Socket.IO server")
    parser.add_argument("--version", action="version", version=__version__)
    parser.parse_args()
    settings = Settings.from_env()
    uvicorn.run(
        create_application(settings),
        host=settings.host,
        port=settings.port,
        loop="asyncio",
        http="h11",
        ws="websockets-sansio",
        workers=1,
        reload=False,
        access_log=False,
        limit_concurrency=512,
        timeout_keep_alive=5,
        timeout_graceful_shutdown=30,
    )


if __name__ == "__main__":
    main()
