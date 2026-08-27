"""Simulated DALI units, built on python-dali's test fakes.

``dali.tests.fakes`` models most of IEC 62386-102 but was written for
python-dali's own tests, which never run a full commissioning cycle and never
drive a configuration UI. The gaps that matter to us are filled here rather
than by patching the vendored copy:

* ``QUERY SHORT ADDRESS`` (0xBB) — the query that reads a selected device's
  short address during the binary search. Without it every device the search
  isolates looks silent, and commissioning readdresses the whole bus.
* A factory random address. ``fakes.Gear`` starts at random address 0 and only
  picks one when it is sent RANDOMISE, so an untouched bus looks like a bus
  where every unit has the same address.
* ``QUERY COLOUR STATUS`` (248) and the colour-type half of ``QUERY COLOUR
  VALUE`` — the DT8 queries wb-mqtt-dali uses to decide which colour features a
  unit has and which colour type is active. The fake answers only the colour
  temperature values, so opening a DT8 device in the editor failed outright.
* The standard gear variables of IEC 62386-102 §9.10 — power-on level, system
  failure level, fade time and rate, fast fade time — and the DT6 dimming curve.
  Real gear always answers these, the editor shows all of them, and a single
  unanswered query in a batch fails the whole parameter read.
"""

from __future__ import annotations

from typing import Optional

from dali.frame import Frame
from dali.gear import colour, general as control_gear, led
from dali.gear.colour import QueryColourValueDTR
from dali.tests import fakes

MASK = 0xFF

# IEC 62386-209 §11.3.4.3, QUERY COLOUR STATUS.
COLOUR_STATUS_TC_OUT_OF_RANGE = 1 << 1
COLOUR_STATUS_TC_ACTIVE = 1 << 5

# IEC 62386-209 §9.11, colour type codes.
COLOUR_TYPE_COLOUR_TEMPERATURE = 0x20

DEVICE_TYPE_COLOUR = 8
DEVICE_TYPE_LED = 6

# IEC 62386-102 Table 9: the reset value of each gear variable.
DEFAULT_POWER_ON_LEVEL = 254
DEFAULT_SYSTEM_FAILURE_LEVEL = 254
DEFAULT_FADE_TIME = 0
DEFAULT_FADE_RATE = 7
DEFAULT_FAST_FADE_TIME = 0


class SimulatedControlGear(fakes.Gear):
    """One DALI control gear unit — a ballast or LED driver.

    :param shortaddr: short address 0..63, or ``None`` for an unaddressed unit
    :param random_address: the 24-bit random address the unit left the factory with
    """

    def __init__(self, shortaddr: Optional[int] = None, random_address: Optional[int] = None, **kwargs):
        super().__init__(shortaddr=shortaddr, **kwargs)
        if random_address is not None:
            self.randomaddr = Frame(24, random_address)
        self.power_on_level = DEFAULT_POWER_ON_LEVEL
        self.system_failure_level = DEFAULT_SYSTEM_FAILURE_LEVEL
        self.fade_time = DEFAULT_FADE_TIME
        self.fade_rate = DEFAULT_FADE_RATE
        self.fast_fade_time = DEFAULT_FAST_FADE_TIME
        self.dimming_curve = 0  # 0 standard (logarithmic), 1 linear

    def send(self, cmd):
        # QUERY COLOUR VALUE selects what to read through DTR0, and the fake
        # overwrites DTR0 with the value it returns — so the selector has to be
        # read before the fake gets the command.
        requested_colour_value = self.dtr0

        answer = super().send(cmd)
        if answer is not None:
            return answer
        # `fakes.Gear.send` has already applied the address filter by this point;
        # re-checking is what keeps this override from answering for other units.
        if not self.valid_address(cmd):
            return None
        if isinstance(cmd, control_gear.QueryShortAddress):
            return self._query_short_address()

        stored = self._store_gear_variable(cmd)
        if stored:
            return None
        answer = self._query_gear_variable(cmd)
        if answer is not None:
            return answer

        if DEVICE_TYPE_LED in self.devicetypes:
            if isinstance(cmd, led.SelectDimmingCurve):
                self.dimming_curve = self.dtr0
                return None
            if isinstance(cmd, led.QueryDimmingCurve):
                return self.dimming_curve
            if isinstance(cmd, led.StoreDTRAsFastFadeTime):
                self.fast_fade_time = min(self.dtr0, 27)
                return None
            if isinstance(cmd, led.QueryFastFadeTime):
                return self.fast_fade_time

        if DEVICE_TYPE_COLOUR not in self.devicetypes:
            return None
        if isinstance(cmd, colour.QueryColourStatus):
            return self._query_colour_status()
        if isinstance(cmd, colour.QueryColourValue):
            return self._query_colour_value(requested_colour_value)
        return None

    def _store_gear_variable(self, cmd) -> bool:
        """The DTR0-carried setters of IEC 62386-102 §11.4."""
        if isinstance(cmd, control_gear.SetPowerOnLevel):
            self.power_on_level = self.dtr0
        elif isinstance(cmd, control_gear.SetSystemFailureLevel):
            self.system_failure_level = self.dtr0
        elif isinstance(cmd, control_gear.SetFadeTime):
            self.fade_time = self.dtr0
        elif isinstance(cmd, control_gear.SetFadeRate):
            self.fade_rate = self.dtr0
        else:
            return False
        return True

    def _query_gear_variable(self, cmd) -> Optional[int]:
        if isinstance(cmd, control_gear.QueryPowerOnLevel):
            return self.power_on_level
        if isinstance(cmd, control_gear.QuerySystemFailureLevel):
            return self.system_failure_level
        if isinstance(cmd, control_gear.QueryFadeTimeFadeRate):
            # One byte carries both: fade time in the high nibble, rate in the low.
            return ((self.fade_time & 0x0F) << 4) | (self.fade_rate & 0x0F)
        return None

    def _query_short_address(self) -> Optional[int]:
        """IEC 62386-102 §11.9: answer only while selected by the search address."""
        if not self.initialising or self.randomaddr != self.searchaddr:
            return None
        if self.shortaddr is None:
            return MASK
        return (self.shortaddr << 1) | 1

    def _query_colour_status(self) -> int:
        """The fake models colour temperature only, so Tc is the active colour type.

        A unit that has never been given a colour reports Tc out of range, which
        is what real gear does before its first ACTIVATE.
        """
        status = COLOUR_STATUS_TC_ACTIVE
        if not self.ct_mired_min <= self.actual_ct <= self.ct_mired_max:
            status |= COLOUR_STATUS_TC_OUT_OF_RANGE
        return status


    def _query_colour_value(self, selector: int) -> Optional[int]:
        """The colour-type selectors the fake does not answer.

        It covers the colour temperature values; these two report *which* colour
        type is in use, which is what the editor reads before deciding which
        colour controls to show.
        """
        if selector in (
            QueryColourValueDTR.ReportColourType.value,
            QueryColourValueDTR.TemporaryColourType.value,
        ):
            return COLOUR_TYPE_COLOUR_TEMPERATURE
        return None


class SimulatedControlDevice(fakes.Device):
    """One DALI-2 control device — a wall switch, presence or light sensor."""

    def __init__(self, shortaddr=None, **kwargs):
        super().__init__(shortaddr=shortaddr, **kwargs)
