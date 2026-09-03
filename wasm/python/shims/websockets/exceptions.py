class WebSocketException(Exception):
    pass


class ConnectionClosed(WebSocketException):
    pass


class ConnectionClosedOK(ConnectionClosed):
    pass


class ConnectionClosedError(ConnectionClosed):
    pass
