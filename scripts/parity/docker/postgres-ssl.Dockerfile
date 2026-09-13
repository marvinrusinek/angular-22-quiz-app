# A disposable, SSL-enabled PostgreSQL image for the cross-runtime parity
# harness — built locally, never pushed to a registry.
#
# Why this exists: the Node backend's own openDatabase() (backend/src/db/
# database.ts) unconditionally sets `ssl: { rejectUnauthorized: false }` on
# its pg.Pool — correct for Neon/managed Postgres in production, but a plain
# `postgres:18-alpine` container has SSL off by default, so node-postgres
# fails immediately with "The server does not support SSL connections"
# (verified directly against a vanilla container before writing this file).
# Rather than touch Node's application code to make SSL conditional just to
# satisfy a test, this Dockerfile makes the disposable database itself
# SSL-capable, matching what the app already expects of ANY Postgres it
# talks to.
#
# The self-signed cert/key are generated and chown'd at BUILD time, inside
# the image — not via a bind-mounted volume — so there are no host/container
# file-ownership mismatches (a well-known pain point with mounted certs).
# Spring's own JDBC driver defaults to sslmode=prefer, so it connects to
# this same instance equally well whether SSL is on or off; only Node
# actually requires it.
FROM postgres:18-alpine

RUN apk add --no-cache openssl \
 && openssl req -new -x509 -days 3650 -nodes -text \
      -subj '/CN=localhost' \
      -out /var/lib/postgresql/server.crt \
      -keyout /var/lib/postgresql/server.key \
 && chmod 600 /var/lib/postgresql/server.key \
 && chown postgres:postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key

CMD ["postgres", "-c", "ssl=on", "-c", "ssl_cert_file=/var/lib/postgresql/server.crt", "-c", "ssl_key_file=/var/lib/postgresql/server.key"]
