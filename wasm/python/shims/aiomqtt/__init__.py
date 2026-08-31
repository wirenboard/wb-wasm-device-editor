"""`aiomqtt` as the browser sees it: a loopback client, not a network client.

wb-mqtt-dali imports exactly three names from aiomqtt — `Message`, `Client` and
`MqttError` — and never opens a connection itself; `main.py` does that, and we
do not use `main.py`. So the whole package reduces to re-exports of the
loopback broker's types.

`Client` here is deliberately NOT constructible the way the real one is: every
client must be attached to a `Broker`, so the runtime creates them explicitly
and this module only provides the type for isinstance checks and annotations.
"""

from wb.mqtt_dali.sim.broker import Client, Message, MqttError, Topic

__all__ = ["Client", "Message", "MqttError", "Topic"]
