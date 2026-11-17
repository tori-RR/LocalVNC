# Synthetic TLS fixtures

Generated locally for isolated HTTPS/WSS tests. These certificates and the
PKCS#12 identity have no relation to a real PVE server or user account.
`server.p12` contains only a disposable TEST ONLY key, with password `TEST_ONLY`.
The server certificate covers localhost and 127.0.0.1. The second CA deliberately
does not sign that server. Do not install these CAs into an OS trust store or
use the identity for a real service.
