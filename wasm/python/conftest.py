"""Make the browser runtime importable exactly as it is inside Pyodide.

`shims` comes first so the stub `aiomqtt` / `websockets` / `wb_common` shadow
any real ones installed on the development machine — the browser will not have
them, so the tests must not either.
"""

import sys
from pathlib import Path

_ROOT = Path(__file__).parent

for _part in ("shims", "runtime", "vendor"):
    _path = str(_ROOT / _part)
    if _path not in sys.path:
        sys.path.insert(0, _path)
