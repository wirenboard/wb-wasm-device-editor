class Request:  # pylint: disable=too-few-public-methods
    pass


class Response:  # pylint: disable=too-few-public-methods
    def __init__(self, status_code=None, reason_phrase="", headers=None, body=None):
        self.status_code = status_code
        self.reason_phrase = reason_phrase
        self.headers = headers
        self.body = body
