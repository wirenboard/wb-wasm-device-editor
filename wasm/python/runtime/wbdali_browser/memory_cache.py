"""A memo of DALI memory-bank bytes, so identity is read off the bus once.

Every device page open and every device initialization begins with the same
reads: memory bank 0 (GTIN, serial, firmware and hardware versions) and bank 1
(OEM data) — dozens of `ReadMemoryLocation` frames per device at ~46 ms each,
answering questions whose answers cannot change. The daemon reads them through
one generator, `read_memory_bank`, which the browser driver executes batch by
batch: `DTR1(bank)`, `DTR0(offset)`, then `ReadMemoryLocation` × n.

This memo sits in the driver and shadows the bus's DTR registers from the
commands passing through, so it knows which (bank, offset) each read targets.
A batch whose reads it can all answer never reaches the wire; the DTR writes
still do, so the real registers stay exactly where the daemon believes they
are, and a batch with a single miss goes out whole — never a mix of remembered
and real bytes.

Trust: a memo entry restored from a previous session is keyed by the random
address the device had then, and is only used after the device at that short
address has answered QUERY RANDOM ADDRESS with the same value — three frames,
against the fifty-odd they replace. A recommissioning command (INITIALISE,
RANDOMISE, PROGRAM SHORT ADDRESS) passing through drops the memo for that
bus, since short addresses are about to change hands.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from dali.device import general as device_general
from dali.gear import general as gear_general

GEAR = "gear"
DEVICE = "device"

_DTR0 = {gear_general.DTR0: GEAR, device_general.DTR0: DEVICE}
_DTR1 = {gear_general.DTR1: GEAR, device_general.DTR1: DEVICE}
_READ = {gear_general.ReadMemoryLocation: GEAR, device_general.ReadMemoryLocation: DEVICE}
_INVALIDATING = {
    gear_general.Initialise: GEAR,
    gear_general.Randomise: GEAR,
    gear_general.ProgramShortAddress: GEAR,
    gear_general.SetShortAddress: GEAR,
    device_general.Initialise: DEVICE,
    device_general.Randomise: DEVICE,
    device_general.ProgramShortAddress: DEVICE,
    device_general.SetShortAddress: DEVICE,
}
_RANDOM_QUERIES = {
    GEAR: (
        gear_general.QueryRandomAddressH,
        gear_general.QueryRandomAddressM,
        gear_general.QueryRandomAddressL,
    ),
    DEVICE: (
        device_general.QueryRandomAddressH,
        device_general.QueryRandomAddressM,
        device_general.QueryRandomAddressL,
    ),
}


class MemoryCache:
    """See the module docstring."""

    def __init__(self, seed: Optional[Dict[str, Any]] = None) -> None:
        # (kind, short) -> {"random": int | None, "banks": {bank: {offset: byte}}, "trusted": bool}
        self._entries: Dict[Tuple[str, int], Dict[str, Any]] = {}
        # Shadow of the bus's DTR0 / DTR1 per kind: the commands are broadcast.
        self._dtr: Dict[str, List[Optional[int]]] = {GEAR: [None, None], DEVICE: [None, None]}
        for kind in (GEAR, DEVICE):
            for short, entry in ((seed or {}).get(kind) or {}).items():
                try:
                    banks = {
                        int(bank): {
                            int(offset): (int(byte) if byte is not None else None)
                            for offset, byte in offsets.items()
                        }
                        for bank, offsets in (entry.get("banks") or {}).items()
                    }
                    random_address = entry.get("random")
                    self._entries[(kind, int(short))] = {
                        "random": int(random_address) if random_address is not None else None,
                        "banks": banks,
                        "trusted": False,
                    }
                except (TypeError, ValueError, AttributeError):
                    continue

    # -- classification ---------------------------------------------------

    @staticmethod
    def kind_and_short(cmd) -> Optional[Tuple[str, int]]:
        """(kind, short address) of a ReadMemoryLocation, else None."""
        kind = _READ.get(type(cmd))
        if kind is None:
            return None
        destination = getattr(cmd, "destination", None)
        short = getattr(destination, "address", None)
        if not isinstance(short, int):
            return None
        return kind, short

    def random_queries(self, kind: str, short: int) -> list:
        from dali.address import DeviceShort, GearShort

        address = GearShort(short) if kind == GEAR else DeviceShort(short)
        return [query(address) for query in _RANDOM_QUERIES[kind]]

    # -- observation ------------------------------------------------------

    def observe(self, cmd, response, delivered: bool = True) -> None:
        """Update the shadow registers and the memo from a wire exchange.

        `delivered` is whether the gateway actually transmitted the frame: a
        read the device left unanswered is a fact about the device (that
        location is not implemented) and is remembered as such, while a frame
        the gateway never sent tells us nothing.
        """
        kind = _DTR0.get(type(cmd))
        if kind is not None:
            self._dtr[kind][0] = cmd.param
            return
        kind = _DTR1.get(type(cmd))
        if kind is not None:
            self._dtr[kind][1] = cmd.param
            return
        kind = _INVALIDATING.get(type(cmd))
        if kind is not None:
            self.invalidate(kind)
            return
        key = self.kind_and_short(cmd)
        if key is None:
            return
        kind = key[0]
        dtr0, dtr1 = self._dtr[kind]
        raw = getattr(response, "raw_value", None)
        if dtr0 is not None and dtr1 is not None and delivered and (raw is None or not raw.error):
            entry = self._entries.setdefault(key, {"random": None, "banks": {}, "trusted": True})
            entry["trusted"] = True
            entry["banks"].setdefault(dtr1, {})[dtr0] = raw.as_integer if raw is not None else None
        # The device increments DTR0 after every READ MEMORY LOCATION it
        # executes, answered or not.
        if dtr0 is not None:
            self._dtr[kind][0] = dtr0 + 1

    def invalidate(self, kind: str) -> None:
        for key in [key for key in self._entries if key[0] == kind]:
            del self._entries[key]

    # -- serving ----------------------------------------------------------

    def untrusted_keys(self, commands) -> List[Tuple[str, int]]:
        """Restored entries this batch would touch that still await verification."""
        keys = []
        for cmd in commands:
            key = self.kind_and_short(cmd)
            if key is None:
                continue
            entry = self._entries.get(key)
            if entry is not None and not entry["trusted"] and key not in keys:
                keys.append(key)
        return keys

    def needs_random_address(self, key: Tuple[str, int]) -> bool:
        """A live-learned entry whose device has not yet told us its random address."""
        entry = self._entries.get(key)
        return entry is not None and entry["trusted"] and entry["random"] is None and bool(entry["banks"])

    def set_random_address(self, key: Tuple[str, int], random_address: Optional[int]) -> None:
        entry = self._entries.get(key)
        if entry is not None:
            entry["random"] = random_address

    def confirm(self, key: Tuple[str, int], random_address: Optional[int]) -> bool:
        """Trust a restored entry if the device answers with the remembered random address."""
        entry = self._entries.get(key)
        if entry is None:
            return False
        if random_address is None or entry["random"] != random_address:
            del self._entries[key]
            return False
        entry["trusted"] = True
        return True

    def plan(self, commands) -> Optional[Dict[int, Optional[int]]]:
        """Bytes for every ReadMemoryLocation in the batch, or None if any is unknown.

        A remembered location the device does not implement maps to None:
        the read is answered with "no answer", exactly as the bus did.

        Walks the batch with a copy of the shadow registers, because the DTR
        writes and the reads' own auto-increment inside the batch decide what
        each read targets.
        """
        dtr = {kind: list(values) for kind, values in self._dtr.items()}
        answers: Dict[int, int] = {}
        for index, cmd in enumerate(commands):
            kind = _DTR0.get(type(cmd))
            if kind is not None:
                dtr[kind][0] = cmd.param
                continue
            kind = _DTR1.get(type(cmd))
            if kind is not None:
                dtr[kind][1] = cmd.param
                continue
            if type(cmd) in _INVALIDATING:
                return None
            key = self.kind_and_short(cmd)
            if key is None:
                continue
            entry = self._entries.get(key)
            dtr0, dtr1 = dtr[key[0]]
            if entry is None or not entry["trusted"] or dtr0 is None or dtr1 is None:
                return None
            bank = entry["banks"].get(dtr1, {})
            if dtr0 not in bank:
                return None
            answers[index] = bank[dtr0]
            dtr[key[0]][0] = dtr0 + 1
        return answers if answers else None

    def apply_served(self, commands) -> None:
        """Advance the shadow registers as if the batch had run — the DTR
        writes did run on the wire, the reads were answered from the memo."""
        for cmd in commands:
            kind = _DTR0.get(type(cmd))
            if kind is not None:
                self._dtr[kind][0] = cmd.param
                continue
            kind = _DTR1.get(type(cmd))
            if kind is not None:
                self._dtr[kind][1] = cmd.param
                continue
            key = self.kind_and_short(cmd)
            if key is not None and self._dtr[key[0]][0] is not None:
                self._dtr[key[0]][0] += 1

    # -- persistence ------------------------------------------------------

    def snapshot(self) -> Dict[str, Any]:
        """The memo as JSON, keyed by the random address each device answered with.

        Entries whose random address is unknown are left out: without it the
        next session could not tell whether the same device still sits at
        that short address, and an unverifiable memo is worse than none. The
        config file's random addresses are deliberately not used as a
        stand-in — they are what the last scan saw, and a device swapped
        since would inherit its predecessor's identity.
        """
        out: Dict[str, Any] = {GEAR: {}, DEVICE: {}}
        for (kind, short), entry in self._entries.items():
            random_address = entry["random"]
            if random_address is None or not entry["banks"]:
                continue
            out[kind][str(short)] = {
                "random": int(random_address),
                "banks": {
                    str(bank): {
                        str(int(offset)): (int(byte) if byte is not None else None)
                        for offset, byte in offsets.items()
                    }
                    for bank, offsets in entry["banks"].items()
                },
            }
        return out
