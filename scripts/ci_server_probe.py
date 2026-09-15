"""Run the real CLI with metadata-only exception capture for an isolated CI fixture."""
from __future__ import annotations

import json
import logging
import traceback
from pathlib import Path

from flask import g, request

PREFIX = 'TONGPIN_CI_EXCEPTION '


def exception_metadata(error, request_id=None, route='(ASGI)'):
    record = {
        'type': type(error).__name__,
        'requestId': request_id,
        'route': route,
        'sqliteName': getattr(error, 'sqlite_errorname', None),
        'frames': [
            {'file': Path(frame.filename).name, 'line': frame.lineno, 'function': frame.name}
            for frame in traceback.extract_tb(error.__traceback__, limit=12)
        ],
    }
    print(PREFIX + json.dumps(record, ensure_ascii=True), flush=True)


class ASGIExceptionMetadata(logging.Filter):
    """Include failures outside Flask without exposing messages, paths or locals."""

    def filter(self, record):
        if record.exc_info and record.exc_info[1] is not None:
            exception_metadata(record.exc_info[1])
        return True


def instrument(application):
    """Keep the normal response handler; print no error values, locals or bodies."""
    flask = application.flask
    original = flask.error_handler_spec[None][None][Exception]

    @flask.errorhandler(Exception)
    def capture(error):
        exception_metadata(error, g.get('request_id'), request.url_rule.rule if request.url_rule else '(unmatched)')
        return original(error)

    return application


def main():
    from tongpin import __main__ as entry

    factory = entry.create_application
    entry.create_application = lambda settings: instrument(factory(settings))
    logger = logging.getLogger('uvicorn.error')
    diagnostic = ASGIExceptionMetadata()
    logger.addFilter(diagnostic)
    try:
        entry.main()
    finally:
        logger.removeFilter(diagnostic)
        entry.create_application = factory


if __name__ == '__main__':
    main()
