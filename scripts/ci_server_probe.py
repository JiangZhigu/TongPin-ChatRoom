"""Run the real CLI with metadata-only exception capture for an isolated CI fixture."""
from __future__ import annotations

import json
import traceback
from pathlib import Path

from flask import g, request

PREFIX = 'TONGPIN_CI_EXCEPTION '


def instrument(application):
    """Keep the normal response handler; print no error values, locals or bodies."""
    flask = application.flask
    original = flask.error_handler_spec[None][None][Exception]

    @flask.errorhandler(Exception)
    def capture(error):
        record = {
            'type': type(error).__name__,
            'requestId': g.get('request_id'),
            'route': request.url_rule.rule if request.url_rule else '(unmatched)',
            'sqliteName': getattr(error, 'sqlite_errorname', None),
            'frames': [
                {'file': Path(frame.filename).name, 'line': frame.lineno, 'function': frame.name}
                for frame in traceback.extract_tb(error.__traceback__, limit=12)
            ],
        }
        print(PREFIX + json.dumps(record, ensure_ascii=True), flush=True)
        return original(error)

    return application


def main():
    from tongpin import __main__ as entry

    factory = entry.create_application
    entry.create_application = lambda settings: instrument(factory(settings))
    try:
        entry.main()
    finally:
        entry.create_application = factory


if __name__ == '__main__':
    main()
