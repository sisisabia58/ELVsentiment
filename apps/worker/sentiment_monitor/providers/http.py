"""HTTP helpers shared by provider clients.

Provider credentials ride in headers, so a redirect must never be followed:
urllib's default handlers forward headers (including x-api-key) to the new
origin. A 3xx is surfaced as a normal HTTPError and mapped to a safe failure.
"""

from __future__ import annotations

import urllib.request
from typing import Any


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


DEFAULT_OPENER = urllib.request.build_opener(NoRedirectHandler)


def urlopen(request: Any, timeout: float | None = None, **kwargs: Any):
    return DEFAULT_OPENER.open(request, timeout=timeout)
