"""wb-mqtt-dali in the browser: the runtime package.

The warnings filter lives here, at the package root, because it must be active
before any vendored module is first compiled: CPython 3.14 warns about
`continue`/`return` inside `finally` — which the vendored daemon and mqttrpc
both do — at import time, and an import runs before any function of ours gets
a chance to. Filtered because the person reading the boot log can do nothing
about upstream code.
"""

import warnings

warnings.filterwarnings("ignore", category=SyntaxWarning)
