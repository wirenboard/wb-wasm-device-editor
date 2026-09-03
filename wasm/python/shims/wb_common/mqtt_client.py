"""Stub for `wb_common.mqtt_client`, imported only by `wb.mqtt_dali.main`."""

DEFAULT_BROKER_URL = "loopback://wbdali-browser"


def make_mqtt_client(*_args, **_kwargs):
    raise NotImplementedError("The browser runtime attaches clients to the loopback broker directly")
