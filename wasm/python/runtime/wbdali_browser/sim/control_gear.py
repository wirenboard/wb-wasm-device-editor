"""Simulated DALI units, built on python-dali's test fakes.

``dali.tests.fakes`` models most of IEC 62386-102 but was written for
python-dali's own tests, which never run a full commissioning cycle. Two things
it leaves out matter to us, and both are added here rather than by patching the
vendored copy:

* ``QUERY SHORT ADDRESS`` (0xBB) — the query that reads a selected device's
  short address during the binary search. Without it every device the search
  isolates looks silent, and commissioning readdresses the whole bus.
* A factory random address. ``fakes.Gear`` starts at random address 0 and only
  picks one when it is sent RANDOMISE, so an untouched bus looks like a bus
  where every unit has the same address.
"""

from __future__ import annotations

from typing import Optional

from dali.frame import Frame
from dali.gear import general as control_gear
from dali.tests import fakes

MASK = 0xFF


class SimulatedControlGear(fakes.Gear):
    """One DALI control gear unit — a ballast or LED driver.

    :param shortaddr: short address 0..63, or ``None`` for an unaddressed unit
    :param random_address: the 24-bit random address the unit left the factory with
    """

    def __init__(self, shortaddr: Optional[int] = None, random_address: Optional[int] = None, **kwargs):
        super().__init__(shortaddr=shortaddr, **kwargs)
        if random_address is not None:
            self.randomaddr = Frame(24, random_address)

    def send(self, cmd):
        answer = super().send(cmd)
        if answer is not None:
            return answer
        if isinstance(cmd, control_gear.QueryShortAddress) and self.valid_address(cmd):
            return self._query_short_address()
        return None

    def _query_short_address(self) -> Optional[int]:
        """IEC 62386-102 §11.9: answer only while selected by the search address."""
        if not self.initialising or self.randomaddr != self.searchaddr:
            return None
        if self.shortaddr is None:
            return MASK
        return (self.shortaddr << 1) | 1


class SimulatedControlDevice(fakes.Device):
    """One DALI-2 control device — a wall switch, presence or light sensor."""

    def __init__(self, shortaddr=None, **kwargs):
        super().__init__(shortaddr=shortaddr, **kwargs)
