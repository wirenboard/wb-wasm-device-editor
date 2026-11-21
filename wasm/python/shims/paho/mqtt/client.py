"""Stand-in for paho's network client, which a browser cannot run.

wb-mqtt-dali takes `MQTTRPCError` from `mqttrpc.client`, which imports this
module at the top for its own synchronous client. Nothing in the browser builds
that client: the daemon talks to the in-process broker through the aiomqtt shim.
"""


class Client:  # pylint: disable=too-few-public-methods
    def __init__(self, *_args, **_kwargs) -> None:
        raise RuntimeError("paho's network client is not available in the browser")
