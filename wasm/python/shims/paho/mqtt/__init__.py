# The vendored paho (python/vendor) carries the topic matcher; this shim adds
# the client stub. Both halves make up one package.
__path__ = __import__("pkgutil").extend_path(__path__, __name__)
