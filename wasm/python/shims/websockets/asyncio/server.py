class ServerConnection:  # pylint: disable=too-few-public-methods
    pass


async def serve(*_args, **_kwargs):
    raise NotImplementedError(
        "The Lunatone DALI Cockpit websocket bridge needs a listening socket, "
        "which a browser tab does not have. Keep websocket_enabled off."
    )
