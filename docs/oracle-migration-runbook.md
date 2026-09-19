# Oracle Cloud Migration Runbook — Spring Interview Service

**Status as of 2026-09-19 (updated): STAGE E CUTOVER APPLIED.** Angular's
production Interview session lifecycle now points at Oracle
(`https://interview-api-spring.marvinrusinek.com`) — `INTERVIEW_PROD_API_BASE_URL`
and the CSP `connect-src` in `src/index.html` were updated together in the
cutover commit (see Stage E below for the exact diff and rationale).
**Render's `interview-api-spring` service remains intact, unmodified, and
running as the verified rollback target (Stage F)** — it was never
stopped, deleted, or reconfigured; only Angular's own routing changed.
Topic Quiz/Weak Areas traffic (Node) and Neon are unaffected by this
cutover. See `docs/spring-production-runbook.md` for the day-to-day
operations doc, now updated to describe Oracle as the current production
Spring host.

## 0. Verified infrastructure facts (provisioned, not yet deployed to)

These are CONFIRMED facts about the already-provisioned VM, given as
verified inputs — this document does not re-derive or verify them against
Oracle Cloud itself (see the hard safety boundary: no Oracle Cloud access).

| Fact | Value |
|---|---|
| VM name | `interview-api-spring-oracle` |
| OS | Ubuntu 24.04 LTS, ARM64/aarch64 |
| Shape | `VM.Standard.A1.Flex`, 1 OCPU, 6 GB RAM |
| Docker Engine | 29.8.1, `linux/arm64` |
| Docker Compose | v5.5.1 |
| UFW (host firewall) | Allows only SSH, TCP 80, TCP 443 inbound |
| OCI ingress (security list) | Allows TCP 80/443; **port 8080 must remain private** |
| Public IP | Reserved (static, assigned to this VM) |
| DNS | `interview-api-spring.marvinrusinek.com` → this VM (live) |

§4 below (originally written before the VM existed, describing a
speculative shape/resource allocation) has been corrected to match these
real numbers rather than the earlier "up to 4 OCPU / 24 GB" range.

**Scope discipline**: only the Spring HOSTING TARGET may eventually change
(Render → Oracle). Node/Express, Topic Quiz, Assessment Builder metadata,
Neon PostgreSQL, and GitHub Pages are permanently unaffected by this
migration — nothing here proposes touching any of them.

---

## 1. Repository and runtime audit (2026-09-19)

### 1.1 Java, Spring Boot, Maven

- **Java 21** (`<java.version>21</java.version>` in `backend-spring/pom.xml`).
- **Spring Boot 4.1.1** (`spring-boot-starter-parent` version).
- **Maven wrapper**: `wrapperVersion=3.3.4`, downloads Apache Maven
  `3.9.16` (`.mvn/wrapper/maven-wrapper.properties`) — `distributionType:
  only-script`, so the wrapper script itself has no platform-specific
  binary; it downloads the platform-independent Maven distribution zip at
  first use.

### 1.2 Dockerfile base images — ARM64 support

`backend-spring/Dockerfile` is multi-stage:

| Stage | Image | Purpose |
|---|---|---|
| `build` | `eclipse-temurin:21-jdk-jammy` | Maven build (JDK + full toolchain) |
| `runtime` | `eclipse-temurin:21-jre-jammy` | Final image (JRE only) |

**Verified via official image manifests** (`docker manifest inspect`, not
inferred from the image name):

```
$ docker manifest inspect eclipse-temurin:21-jdk-jammy | grep architecture
"architecture": "amd64"
"architecture": "arm64"
"architecture": "ppc64le"
"architecture": "s390x"

$ docker manifest inspect eclipse-temurin:21-jre-jammy | grep architecture
"architecture": "amd64"
"architecture": "arm64"
"architecture": "ppc64le"
"architecture": "s390x"
```

Both stages' base images publish an official `linux/arm64` manifest. See
§2 for the actual cross-platform build proof, not just this manifest check.

### 1.3 Architecture-specific dependencies

None found. `pom.xml`'s runtime/compile dependency tree is pure JVM:
`spring-boot-starter-actuator`, `-validation`, `-webmvc`, `-data-jpa`, the
`postgresql` JDBC driver (`scope: runtime`, pure Java, no native/JNI
component). The ONLY architecture-adjacent dependencies —
`spring-boot-testcontainers`, `testcontainers-junit-jupiter`,
`testcontainers-postgresql` — are all `scope: test`, never packaged into
the runtime image, and never invoked by the Dockerfile's own build (it
runs `package -DskipTests`, explicitly skipping the phase Testcontainers
binds to — see the Dockerfile's own comment on why: no Docker socket
available during a Render/PaaS build). No native library, JNI binding, or
shell command anywhere in `pom.xml`, the Dockerfile, or
`application*.properties` assumes a specific CPU architecture.

### 1.4 Container user, port, health checks, JVM flags

- **User**: `RUN useradd --system --create-home --shell /usr/sbin/nologin
  appuser` then `USER appuser` — the image **already runs as non-root**,
  confirmed both from the Dockerfile source and empirically from the built
  image (§2.3).
- **Port**: `server.port=${PORT:8080}` (`application.properties`) — binds
  to `$PORT` if set (Render's convention), else `8080`. `EXPOSE 8080` in
  the Dockerfile. No explicit bind-address property is set, so Spring
  binds to Tomcat's own default, `0.0.0.0` — this is what lets a
  container's port mapping/publish work at all, and is unchanged by this
  migration.
- **Health check**: `HEALTHCHECK ... CMD bash -c 'exec
  3<>/dev/tcp/127.0.0.1/${PORT:-8080}'` — a plain TCP reachability check
  (no curl/wget in the minimal JRE image). This proves the process is
  listening, nothing about application or database readiness — see §1.8.
- **JVM flags**: none. `CMD ["java", "-jar", "app.jar"]` — no `-Xmx`/`-Xms`
  or container-memory-awareness flags set explicitly. Modern JDK 21
  defaults to `-XX:+UseContainerSupport` automatically (on by default
  since JDK 10+), so the JVM already sizes its heap as a fraction of the
  CONTAINER's memory limit (via cgroup) rather than the host's — this
  matters directly for Oracle's Always Free Ampere A1 allocation (§4.1):
  whatever memory limit the compose service is given, the JVM will
  respect it without extra flags, but an explicit `-XX:MaxRAMPercentage`
  is still worth setting once the real VM's memory budget is known (not
  done here — no real Oracle VM exists yet to size it against).

### 1.5 Non-root confirmation

Confirmed twice: Dockerfile source (§1.4) and the actual built ARM64
image's `Config.User` field (§2.3) both show `appuser`, not root.

### 1.6 Render build/start configuration and required environment variables

From `render.yaml`, the `interview-api-spring` service:

- `runtime: docker`, `dockerfilePath: ./backend-spring/Dockerfile`,
  `dockerContext: ./backend-spring` (repo-root-relative — Oracle's
  `deploy/oracle/compose.yaml` mirrors this with `context:
  ../../backend-spring`).
- `plan: free`, `region: oregon` (same region as Neon — kept for latency;
  Oracle's own region choice in §4.1 should ideally be chosen the same way
  once available in the free-tier region list).
- `autoDeploy: false` — this service has always required an explicit
  operator action to deploy, never a push to `main`. The same discipline
  applies to Oracle: nothing in this migration auto-deploys either.
- `healthCheckPath: /actuator/health/readiness`.

**Environment variable NAMES only** (values are never recorded here, in
`render.yaml`, or anywhere in this repository — every one of these uses
Render's `sync: false`, meaning Render prompts for the value and keeps it
out of the committed blueprint), classified by actual Spring behavior —
**not every one of these is fail-closed**, corrected below after an
internal inconsistency was caught in a later review pass (an earlier
draft of this section claimed all five were "fail-closed with no
default," which directly contradicted §1.7's own accurate description of
`ALLOWED_ORIGINS`'s real, documented empty-default behavior):

**Required (fail-closed — the app refuses to start without these):**
- `SPRING_DATASOURCE_URL`
- `SPRING_DATASOURCE_USERNAME`
- `SPRING_DATASOURCE_PASSWORD`
- `TOPIC_QUIZ_RECEIPT_SECRET`

**Optional (Spring has a defined, safe default if unset):**
- `ALLOWED_ORIGINS` — defaults to an EMPTY allow-list (§1.7) — the app
  starts fine, it simply accepts no cross-origin frontend calls until set.
- `PORT` — supplied BY Render itself on Render; defaults to `8080` if
  unset, which is what Oracle's `deploy/oracle/compose.yaml` relies on
  (it never sets `PORT` at all — see §3).

Oracle's `deploy/oracle/.env.example` lists the same four REQUIRED names
plus `ALLOWED_ORIGINS` (documented there as optional, matching this
classification exactly) — §3 below covers the two Oracle-only additions,
`SPRING_API_DOMAIN` and `SPRING_IMAGE_TAG`, which control the deployment
layer, not the Spring application.

### 1.7 Spring configuration defaults and fail-closed behavior

The four REQUIRED variables above are **fail-closed with no default**:

- `spring.datasource.url/username/password` — no default value in
  `application.properties`; Spring's own `DataSource` autoconfiguration
  fails at startup with a clear "DataSource 'url' attribute is not
  specified" error if unset. No silent no-database mode exists.
- `topicquiz.receipt-secret=${TOPIC_QUIZ_RECEIPT_SECRET:}` — resolves to
  an empty string if unset, and `TopicQuizReceiptSecret`
  (`com.quizbackend.quiz.receipt`) refuses to construct on an empty value,
  which fails the whole application context. Minimum 32 characters
  enforced the same way.
- `cors.allowed-origins=${ALLOWED_ORIGINS:}` — resolves to an EMPTY
  allow-list if unset (deliberately more restrictive than Node's own
  dev-mode fallback — see `AllowedOrigins.java`'s doc comment), and a
  literal `*` is structurally rejected at startup
  (`IllegalStateException`) regardless of environment. There is no
  "production flag" in this codebase that gates stricter behavior — every
  environment gets the same strict validation, always.

`spring.jpa.hibernate.ddl-auto=validate` — Hibernate validates entity
mappings against the EXISTING schema at startup and never creates, drops,
or alters anything. This is directly relevant to §1.10 (overlap safety):
Spring has **no migration-authoring capability of its own** in this
codebase; it can only run against a Neon schema Node's own migrations
(`backend/src/db/migrations/`) have already brought fully up to date.

### 1.7a Existing test suite (verified 2026-09-19, unrelated to Oracle-specific changes)

`./mvnw -B verify` — same command the Dockerfile's `dependency:go-offline`
layer sits alongside, run natively (not inside a build) to prove the
complete result, cross-checked against the actual generated
`target/surefire-reports/*.txt` and `target/failsafe-reports/*.txt` files
(31 and 5 report files respectively), not just console output:

| Plugin | Test classes | Tests run | Failures | Errors | Skipped |
|---|---|---|---|---|---|
| Surefire (unit tests, `mvnw verify`'s `test` phase) | 31 | **431** | 0 | 0 | 0 |
| Failsafe (integration tests, Testcontainers-backed `*IT` classes) | 5 | **38** | 0 | 0 | 0 |
| **Combined** | **36** | **469** | **0** | **0** | **0** |

An earlier draft report for this migration task stated only "38 tests,
0 failures" — that number is the Failsafe-only total (the LAST "Tests
run:" summary line Maven prints before `BUILD SUCCESS`), mistakenly
reported as if it were the complete result. No test source directory,
profile, module, or plugin execution is skipped: `mvnw -B verify` runs
both `surefire:test` (`default-test` execution) and
`failsafe:integration-test`/`failsafe:verify` (`default` executions) —
all default lifecycle bindings, nothing custom or disabled. This
correction is documentation-only; no test configuration was changed to
produce it.

### 1.8 Readiness/liveness/health endpoints — what each actually proves

| Endpoint | Proves | Does NOT prove |
|---|---|---|
| `GET /api/health` | The process is up and answering HTTP (mirrors Node's own `GET /api/health` contract exactly: `{"status":"ok","uptimeSeconds":<n>}`) | Database connectivity, CORS config, anything about Neon |
| `GET /actuator/health/readiness` | Spring's own application-lifecycle readiness state (`readinessState` only) | **Database connectivity** — empirically verified (disposable-Postgres outage test, documented in `docs/spring-production-runbook.md` §4) to stay `200/UP` throughout a real Neon outage. `db` is deliberately NOT wired into this group; see that same section for why (HikariCP's ~30s default connection wait vs. Render's 5s health-check timeout would otherwise make ordinary cold-start latency look like a hard failure) |
| `GET /actuator/health` | Same conservative default as the readiness group — Actuator is left at Spring Boot's OWN defaults (`show-details=never`, only `health` exposed over HTTP) — no `management.*` property overrides this anywhere in the codebase | Anything beyond overall UP/DOWN |

Database reachability, when it actually needs proving, is demonstrated by
a real data-fetching call such as `GET /api/quizzes` succeeding — not by
any of the three endpoints above. This distinction carries over unchanged
to Oracle.

### 1.9 Frontend/CSP/CORS references — cutover edits (APPLIED 2026-09-19, Stage E)

| Location | Prior value | Cutover action (Stage E) |
|---|---|---|
| `src/app/shared/tokens/api-base-url.token.ts` | `INTERVIEW_PROD_API_BASE_URL = 'https://interview-api-spring.onrender.com/api'` | → `https://interview-api-spring.marvinrusinek.com/api` — **done** |
| `src/index.html` CSP `connect-src` | Listed `https://interview-api-spring.onrender.com` (and Node's origin, and local dev ports) | REPLACED with `https://interview-api-spring.marvinrusinek.com` (no duplicate Spring origin retained) — **done** |
| `docs/spring-production-runbook.md` | Referenced `interview-api-spring.onrender.com` in §1, §4 (health check commands) as production | Updated to describe Oracle as current production, Render as intact rollback — **done** |
| `render.yaml` | `interview-api-spring` service definition | Unchanged — Render remains the rollback target (§Stage F); this file is not touched by the migration |

This preparation-stage table is left in place as a historical record of what
Stage E's own execution (below) confirms was actually applied.

### 1.10 Migration mechanism and dual-instance-against-Neon safety

Schema migrations are **Node-owned only** (`backend/src/db/migrations/`,
plain numbered `.sql` files, no migration framework). Spring never runs a
migration — `ddl-auto=validate` (§1.7) makes this structural, not just a
convention. This means:

**Two Spring instances (Render + a future Oracle instance) pointed at the
same Neon database simultaneously is schema-safe** — neither one can
mutate the schema; both only `validate` against whatever Node's
migrations have already established, and both read/write application data
through the same JPA/JDBC mappings already proven compatible with Node's
own runtime access to the same tables (the existing `Cross-Runtime Parity`
CI workflow already establishes this compatibility between Node and
Spring; a second SPRING instance adds no new compatibility question, only
a second connection-pool consumer — see the next paragraph).

The one real resource consideration is **connection pool sizing**: each
Spring instance runs its own HikariCP pool against Neon's pooled
("-pooler") endpoint. During Stage C (Oracle deployed, zero real user
traffic — Angular still points at Render), this is a non-issue. During any
period where BOTH are simultaneously live to real traffic (not currently
planned — Stage E is a single cutover, not a gradual shift), pool sizing
would need explicit attention; this document does not propose a
dual-live-traffic period, so it is noted as a constraint rather than
solved here.

### 1.11 Logging

No `logback-spring.xml` or `logging.file.*` property exists anywhere in
`backend-spring/`. Spring Boot's own default Logback configuration logs to
**stdout/stderr only** — already exactly Docker-native, no file-based
logging assumption to adapt for the container migration. Compose's own
Docker log driver (default `json-file`) captures this the same way Render
already does; log rotation/disk-usage guidance for the VM itself is in §4.

### 1.12 Existing rollback documentation and gaps

`docs/spring-production-runbook.md` §6 ("Rollback procedure — Interview
Mode only") already documents the Render-side rollback mechanism (revert
`INTERVIEW_PROD_API_BASE_URL`, keep both CSP origins, redeploy GitHub
Pages, verify, never touch Neon). **Gap this document fills**: that
section assumes rollback FROM Spring TO Node — it says nothing about
Oracle specifically, since Oracle did not exist as a target when it was
written. Stage F below extends the same pattern (frontend-only rollback,
no data-layer step, no service deletion) to the Oracle-specific case:
rolling back FROM Oracle TO Render (not to Node), while keeping Oracle
intact for diagnosis.

---

## 2. ARM64 verification (2026-09-19)

Performed entirely locally; no image was pushed to any registry; nothing
in this section touched Render, Neon, or any Oracle resource.

### 2.1 Cross-platform build

```
docker buildx build --platform linux/arm64 -t quizbackend-spring-arm64-verify:local --load .
```

Run from `backend-spring/`, using the EXISTING, unmodified Dockerfile — no
Dockerfile edit was made to get this to pass. Both the `build` stage
(Maven, under QEMU emulation) and the `runtime` stage completed
successfully:

- `mvnw -B dependency:go-offline`: succeeded (`BUILD SUCCESS`, ~4m 43s
  under emulation).
- `mvnw -B clean package -DskipTests`: succeeded — 112 main source files
  and 38 test source files compiled, JAR built, Spring Boot repackage
  completed (`BUILD SUCCESS`, ~4m 49s under emulation).
- Image exported and loaded locally as `quizbackend-spring-arm64-verify:local`.

**Conclusion: the existing Dockerfile builds cleanly for `linux/arm64`, no
Dockerfile changes required.**

### 2.2 Bounded smoke boot

An isolated Docker network and a **disposable local PostgreSQL container**
(`postgres:18-alpine`, synthetic credentials, never Neon) were created
specifically for this test, with the same 8 migration files from
`backend/src/db/migrations/` applied in order — the exact schema the real
app expects `ddl-auto=validate` to succeed against.

The ARM64 image was then run under QEMU emulation
(`--platform` mismatch confirmed by Docker's own warning:
`WARNING: The requested image's platform (linux/arm64) does not match the
detected host platform (linux/amd64/v3)`), with synthetic, clearly-labeled
environment values (`TOPIC_QUIZ_RECEIPT_SECRET=synthetic-arm64-smoke-test-secret-not-real-0000`,
`ALLOWED_ORIGINS=https://example-verify-only.test`) pointed ONLY at the
disposable Postgres container — never Neon.

**Result: successful boot, fully verified.** Under QEMU emulation the JVM
boot took ~262 seconds (`Started QuizBackendApplication in 261.899
seconds`) — this is an EMULATION artifact only (binary translation
overhead for JIT-heavy JVM/Hibernate startup), not representative of real
Ampere A1 hardware, which runs ARM64 natively rather than translating
amd64 instructions. Log excerpts confirming a clean, error-free startup
against the disposable Postgres:

```
HikariPool-1 - Starting...
HikariPool-1 - Added connection org.postgresql.jdbc.PgConnection@...
HikariPool-1 - Start completed.
Database info: Database JDBC URL [jdbc:postgresql://quizbackend-arm64-verify-pg:5432/verifydb]
Database dialect: PostgreSQLDialect
Database version: 18.6
Initialized JPA EntityManagerFactory for persistence unit 'default'
Exposing 1 endpoint beneath base path '/actuator'
Tomcat started on port 8080 (http) with context path '/'
Started QuizBackendApplication in 261.899 seconds
```

No Hibernate validation error (proves the entity mappings match the 8
applied migrations exactly, on ARM64), no startup exception.

**Health/readiness/liveness, all hit and all correct:**

```
$ curl -s -w '\nHTTP %{http_code}\n' http://localhost:18080/api/health
{"status":"ok","uptimeSeconds":378}
HTTP 200

$ curl -s -w '\nHTTP %{http_code}\n' http://localhost:18080/actuator/health/readiness
{"status":"UP"}
HTTP 200

$ curl -s -w '\nHTTP %{http_code}\n' http://localhost:18080/actuator/health
{"groups":["liveness","readiness"],"status":"UP"}
HTTP 200

$ docker inspect <container> --format '{{.State.Health.Status}}'
healthy
```

**A real database-backed read, not just connection-pool init:**

```
$ curl -s -w '\nHTTP %{http_code}\n' http://localhost:18080/api/quizzes
{"quizzes":[]}
HTTP 200
```

(Empty array is expected and correct — only schema migrations were
applied to the disposable database, no data was seeded; this proves the
full JDBC → Hibernate → JSON-serialization read path executes correctly
on ARM64, which is what mattered here, not the data itself.)

**Conclusion: the existing, unmodified Spring application runs correctly
under `linux/arm64`** — builds, boots, connects to PostgreSQL, validates
its schema, serves all three health-adjacent endpoints correctly, and
answers a real database-backed request. No blocker for Oracle Ampere A1
was found.

### 2.3 Image inspection

```
$ docker image inspect quizbackend-spring-arm64-verify:local --format '{{.Architecture}} {{.Os}}'
arm64 linux

$ docker image inspect quizbackend-spring-arm64-verify:local --format '{{.Config.User}}'
appuser

$ docker image inspect quizbackend-spring-arm64-verify:local --format '{{.Config.ExposedPorts}}'
map[8080/tcp:{}]

$ docker image inspect quizbackend-spring-arm64-verify:local --format '{{.Config.Env}}'
[PATH=/opt/java/openjdk/bin:... JAVA_HOME=/opt/java/openjdk LANG=en_US.UTF-8 LANGUAGE=en_US:en LC_ALL=en_US.UTF-8 JAVA_VERSION=jdk-21.0.12+8]
```

- **Architecture**: `arm64` — confirmed, not inferred.
- **User**: `appuser` — non-root, confirmed on the actual built image, not
  just the Dockerfile source.
- **Exposed ports**: `8080/tcp` only.
- **Baked-in environment**: standard JDK toolchain variables only
  (`PATH`, `JAVA_HOME`, locale, `JAVA_VERSION`). No
  `SPRING_DATASOURCE_*`, no `TOPIC_QUIZ_RECEIPT_SECRET`, no credential of
  any kind baked into the image.
- **Full `docker history --no-trunc`** and the inspect output above were
  scanned for `secret|password|SPRING_DATASOURCE|TOPIC_QUIZ_RECEIPT|
  jdbc:postgresql://[a-z]|neon\.tech` — zero matches beyond the scan
  script's own section-header text.

### 2.4 Cleanup

All temporary resources removed after verification: the smoke-test
container, the disposable Postgres container, the isolated network, and
the locally-built `quizbackend-spring-arm64-verify:local` image itself
(never pushed to any registry at any point).

---

## 3. Deployment package — `deploy/oracle/`

| File | Purpose |
|---|---|
| `compose.yaml` | Runs Spring (built from `../../backend-spring`, unmodified) + Caddy only. No PostgreSQL service. Spring's port is never published to the host — only Caddy's 80/443 are. |
| `Caddyfile` | Automatic HTTPS reverse proxy to Spring. Blocks `/actuator/*` entirely (defense in depth beyond Spring's own conservative Actuator defaults). Adds only the security headers Spring does not already set itself (avoids duplicating/conflicting with `SecurityHeadersFilter`). |
| `.env.example` | Every required variable NAME with a placeholder value and a comment distinguishing "Oracle deployment" variables (`SPRING_API_DOMAIN`, `SPRING_IMAGE_TAG`) from "Spring application" variables (the same five names Render already uses). No real values. |
| `scripts/preflight.sh` | Confirms every required variable NAME is set before a deploy — never prints a value. |
| `scripts/deploy.sh` | Records the currently-running image tag (for rollback), builds, and starts the stack. |
| `scripts/health-check.sh` | Checks Spring's `/api/health` over the internal network AND, if a domain is configured, the public HTTPS path — plus confirms Actuator returns 404 publicly. |
| `scripts/rollback.sh` | Retags the previous image back into place and restarts — a container-level rollback, distinct from (and not a substitute for) the production frontend rollback in Stage F. |

**Not created**: Terraform/OCI CLI automation (the VM itself now exists
— §0 — but its tenancy OCID, availability domain, and subnet identifiers
are not part of this task's verified inputs, and this task has no Oracle
Cloud access to look them up) and a systemd unit
(Docker Compose's own `restart: unless-stopped` policy, combined with
`systemctl enable docker` at the OS level — see §4.6 — already recovers
correctly across both an individual container failure and a full VM
reboot; a second, parallel process-supervision layer on top of that would
be redundant rather than additive).

---

## 4. Security and networking plan (documented, NOT applied)

### 4.1 VM shape and image — AS PROVISIONED (§0)

- **Image**: Ubuntu 24.04 LTS, ARM64/aarch64 — confirmed, not speculative.
- **Shape**: `VM.Standard.A1.Flex`, **1 OCPU, 6 GB RAM** — a smaller
  allocation than Oracle's Always Free maximum (up to 4 OCPU/24 GB total
  across A1 instances), leaving headroom in the tenancy's Always Free
  budget for other use. 1 OCPU / 6 GB is comfortably sufficient for one
  Spring Boot instance (JDK 21 auto-sizes its heap to the CONTAINER's
  cgroup memory limit — see §1.4) plus one Caddy instance; neither is
  resource-intensive at this traffic level.
- **Docker/Compose**: Engine 29.8.1, Compose v5.5.1, both `linux/arm64` —
  already installed (§0). `deploy/oracle/compose.yaml` uses only Compose
  Specification syntax stable across this version range (`name:`,
  `healthcheck:`, `depends_on: condition:`, `expose:` vs `ports:`) —
  verified against this exact Compose version via `docker compose config`
  (§13 below), not assumed compatible.

### 4.2 SSH key handling

- Generate a dedicated key pair FOR this VM (do not reuse an existing
  personal key) — `ssh-keygen -t ed25519 -C "oracle-spring-interview-vm"`.
  Supply only the PUBLIC key to Oracle at instance-creation time (the
  Console flow uploads/pastes the public key; the private key never
  leaves the local machine).
- Store the private key with `chmod 600`, never commit it, never paste it
  into a chat/ticket/doc.
- Disable password SSH authentication in `sshd_config`
  (`PasswordAuthentication no`) once key-based access is confirmed
  working — do this AFTER verifying the key-based login succeeds, not
  before.

### 4.3 OCI network security rules — AS PROVISIONED (§0)

| Port | Rule | Status |
|---|---|---|
| 22 (SSH) | Restricted to the operator's current public IP where practical — re-add/update if that IP changes (residential IPs are often dynamic) | Confirmed: OCI ingress allows TCP 80/443; SSH access exists (§0) |
| 80, 443 | Public (`0.0.0.0/0`) — required for Caddy's HTTP-01 ACME challenge and normal HTTPS traffic | **Confirmed live** (§0) |
| 8080 | **NOT public** — no ingress security rule for it at all; Spring is reached only via Caddy inside the VM | **Confirmed: OCI ingress does not include 8080** (§0) |
| 5432 (PostgreSQL) | **No inbound rule** — nothing runs PostgreSQL on this VM; Neon is reached as an OUTBOUND connection the VM initiates, which needs no inbound rule to permit | Consistent with §0 (no such rule listed) |

### 4.4 Ubuntu firewall (ufw) — AS PROVISIONED (§0)

**Confirmed already configured**: UFW allows only SSH, TCP 80, and TCP
443 inbound (§0) — matching the OCI security-list rules above exactly,
defense in depth already in place. The illustrative ruleset this section
previously proposed (`ufw default deny incoming; ufw allow ... 22/80/443;
ufw enable`) is superseded by this confirmed state — shown here only as
the reference shape that was verified to already match:

```
ufw default deny incoming
ufw default allow outgoing
ufw allow from <operator-IP>/32 to any port 22 proto tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

### 4.5 OS updates

- Enable `unattended-upgrades` for security patches
  (`apt install unattended-upgrades`, `dpkg-reconfigure -plow
  unattended-upgrades`) — Ubuntu's standard mechanism, applies security
  updates automatically without requiring manual intervention for every
  CVE.
- A full `apt update && apt upgrade` before first deploying, and
  periodically thereafter for non-security package updates
  unattended-upgrades does not cover.

### 4.6 Docker installation and restart-on-reboot

- **Already installed**: Docker Engine 29.8.1 + Compose v5.5.1,
  `linux/arm64` (§0) — confirmed, not a remaining setup step.
- `systemctl enable docker` (Docker's own installer typically does this
  already; confirm with `systemctl is-enabled docker`) — ensures the
  Docker daemon itself starts on VM boot, which combined with
  `restart: unless-stopped` on both compose services (already set in
  `compose.yaml`) recovers the whole stack after a VM reboot with no
  additional systemd unit (§3's "not created" rationale).
- **CORRECTED — do NOT add the `ubuntu` user to the `docker` group.** An
  earlier draft of this section recommended exactly that for
  least-privilege routine operations; that recommendation was wrong and
  has been reversed. Docker group membership is root-equivalent (a
  member can bind-mount the host root filesystem into a container and
  read/write anything as root — it is not meaningfully less privileged
  than `sudo` for this purpose, only less auditable). Every Docker
  command this deployment needs goes through `sudo` instead — all three
  Docker-touching scripts under `deploy/oracle/scripts/` (`deploy.sh`,
  `health-check.sh`, `rollback.sh`) now check for daemon access up front
  and fail with a clear message (not a raw permission-denied error) if
  not run with `sudo`. `preflight.sh` never touches Docker and needs no
  elevation.

### 4.7 Non-root application container

Already true today (§1.5, §2.3) — the existing image needs no change.
`compose.yaml` does not override the image's `USER`.

### 4.8 Secret file ownership and permissions

- `deploy/oracle/.env` on the VM: `chmod 600`, owned by the deploy
  operator's user (not world- or group-readable).
- Never place `.env` inside a directory served by Caddy or any other web
  process.
- If secrets need to be entered interactively (rather than piped from a
  password manager's CLI) use a prompt that does not echo to the
  terminal, e.g. `read -rs SPRING_DATASOURCE_PASSWORD` in a short,
  throwaway shell snippet that writes directly into `.env` — never type a
  secret as a bare command-line argument (it would land in shell
  history).

### 4.9 Caddy certificate storage

Already covered by `compose.yaml`'s `caddy_data`/`caddy_config` named
volumes (§3) — Caddy persists its ACME account key and issued
certificates there across container restarts, so a normal
`docker compose up -d` after a code change does not re-trigger
certificate issuance (avoiding Let's Encrypt's rate limits).

### 4.10 Log access, rotation, disk usage

- Configure Docker's `json-file` log driver with bounded rotation
  (`max-size`/`max-file`) — either globally in `/etc/docker/daemon.json`
  or per-service in `compose.yaml` once real usage patterns are known;
  left unset for now since no real traffic volume exists yet to size
  against.
- Periodically check `df -h` / `docker system df` on the VM — an Always
  Free instance's boot volume is finite, and unrotated logs or
  accumulated unused images are the most likely way to exhaust it over
  time.

### 4.11 Verifying Spring is not exposed on 8080

Two independent checks, both non-destructive:
1. From OUTSIDE the VM: `curl -m 5 http://<vm-public-ip>:8080/api/health`
   should time out/refuse — no OCI security-list rule permits it, and
   `compose.yaml` never publishes the port regardless.
2. From ON the VM (but outside the containers): `curl -m 5
   http://127.0.0.1:8080/api/health` should ALSO fail — `expose:` (not
   `ports:`) in `compose.yaml` means the port is reachable only from
   other containers on the same compose network, not from the host's own
   loopback interface either.

### 4.12 Avoiding accidental Actuator exposure

Two independent layers (§1.8, `Caddyfile` in §3): Spring's own Actuator
defaults (`show-details=never`, only `/actuator/health` exposed at all),
and Caddy's explicit `respond @actuator 404` for the entire `/actuator*`
prefix regardless of what Spring itself would have returned. Verified
with `scripts/health-check.sh`'s own `/actuator/health` check (expects
404 through the public path).

### 4.13 Rotating credentials later

- Neon credentials: rotate in Neon's own dashboard, then update
  `SPRING_DATASOURCE_PASSWORD` in `.env` on the VM and
  `docker compose up -d spring` to pick it up — no image rebuild needed
  (it's an environment variable, not baked into the image, per §2.3).
- `TOPIC_QUIZ_RECEIPT_SECRET`: must be rotated on Node and Spring
  SIMULTANEOUSLY (§1.6's own note on why — a receipt issued by one
  runtime must verify on the other) — coordinate the Render (Node) and
  Oracle (Spring) updates as one change, not two independent ones.
- SSH key: replace via the OCI Console's instance metadata / a new
  `authorized_keys` entry, confirm the new key works, THEN remove the old
  one — never remove access before confirming the replacement works.

### 4.14 Always Free limitations (stated honestly)

- **No uptime SLA** — Always Free resources are provided without a
  service-level commitment; Oracle can reclaim genuinely idle Always Free
  resources under its own idle-instance reclamation policy (distinct from
  a paid tier's guarantees). This VM already exists (§0) — the ongoing
  risk is ORACLE-SIDE reclamation of an idle instance over time, not
  creation-time capacity availability, which is now moot.
- **Unlike Render's free tier, an always-on VM does not idle/cold-start**
  the way the current Spring-on-Render deployment does — this removes the
  cold-start class of issue entirely once the stack is actually running,
  but trades it for the reclamation/no-SLA risk above, which Render's
  free tier does not carry in the same form.
- **Idle behavior must still be VERIFIED, not assumed** — Stage C below
  includes an explicit idle-period check (no cold start recurring after
  20+ minutes of zero Spring traffic) precisely because "always-on VM"
  is the hypothesis this migration exists to validate, not a fact to
  take on faith.

---

## 5. Migration and rollback stages

### Stage A — Baseline preservation

Recorded 2026-09-19, before any Oracle work:

- **Current known-good `main` commit**: `245cda3a787b7c7fc078352acdacfc7ae7e2bb6a`
  (`perf(interview): warm Spring from quiz selection`).
- **Current Render Spring endpoint**: `https://interview-api-spring.onrender.com`
  (unchanged, still serving production Interview Mode traffic).
- **Proposed tag name**: `spring-render-before-oracle-cutover` — **not
  created or pushed** by this task; create it only immediately before
  Stage E's actual cutover, pointed at whatever `main` commit is current
  at that time (likely later than the one recorded above).
- **Render remains running** — confirmed; this task made no Render API
  call, dashboard change, or deploy trigger of any kind.
- **Current GitHub Pages deployment**: `gh-pages` branch HEAD
  `77a82472ad55407d5a93116a3309871cb4aadc23`
  (`deploy: 245cda3a - perf(interview): warm Spring from quiz selection`).
- **Environment variable NAMES in use today** (Render dashboard, values
  never recorded here): `SPRING_DATASOURCE_URL`,
  `SPRING_DATASOURCE_USERNAME`, `SPRING_DATASOURCE_PASSWORD`,
  `TOPIC_QUIZ_RECEIPT_SECRET`, `ALLOWED_ORIGINS` (Spring);
  `DATABASE_URL`, `ALLOWED_ORIGINS`, `NODE_ENV` (Node, unaffected by this
  migration, listed here only for completeness of the baseline).

### Stage B — Oracle VM preparation — **ALREADY COMPLETE** (§0)

Recorded as verified infrastructure facts, not re-verified by this task
(no Oracle Cloud access):

1. ✅ **VM created**: `interview-api-spring-oracle`, Ubuntu 24.04 LTS
   ARM64, `VM.Standard.A1.Flex` (1 OCPU / 6 GB).
2. ✅ **Networking/firewall**: OCI ingress allows TCP 80/443 only (8080
   NOT public); UFW independently mirrors the same allow-list (SSH,
   80, 443) at the OS level.
3. ✅ **Reserved public IP** assigned.
4. ✅ **DNS live**: `interview-api-spring.marvinrusinek.com` → the VM's
   reserved IP — a Stage-B prerequisite for Caddy's automatic HTTPS
   (§Caddyfile), satisfied.
5. ✅ **Docker + Compose installed**: Engine 29.8.1, Compose v5.5.1,
   `linux/arm64`. Caddy itself is NOT installed on the host — it runs as
   the `caddy` container defined in `compose.yaml`, so no separate
   host-level Caddy install is or was needed.

**Still to confirm manually before Stage C** (operator action, not
automatable from here, no Oracle Cloud access from this task):
SSH key-based login works (`ssh ubuntu@interview-api-spring.marvinrusinek.com`
or via the reserved IP) — confirm this BEFORE disabling password auth if
it hasn't been disabled already, and confirm `sudo docker info` succeeds
on the VM (proves the Docker daemon is actually reachable, not merely
installed).

### Stage C — Deploy without frontend cutover

Angular's production Spring base URL still points at Render throughout
this stage — Oracle receives ZERO real user traffic here.

1. `git clone` this repository onto the VM (needed anyway: `deploy.sh`
   derives its immutable image tag from `git rev-parse` — see §3), copy
   `.env.example` to `.env`. `SPRING_API_DOMAIN` is already the real,
   correct value in `.env.example`
   (`interview-api-spring.marvinrusinek.com`) — fill in the remaining
   Neon credentials (the SAME ones Render already uses, §1.6) and
   `TOPIC_QUIZ_RECEIPT_SECRET` (same value Node already has).
2. `sudo ./scripts/preflight.sh` then `sudo ./scripts/deploy.sh` (both
   Docker-touching scripts require `sudo` — the `ubuntu` user is
   deliberately not in the `docker` group; see §4.6).
3. **Validate migrations/schema compatibility without destructive
   change**: `ddl-auto=validate` (§1.7) means a successful Spring startup
   on the VM IS the compatibility proof — if the schema Node's migrations
   have established doesn't match Spring's entity mappings, the
   application fails to start with a clear Hibernate validation error
   rather than silently drifting. No manual schema comparison step is
   needed beyond "did it start."
4. **Verify** (against the Oracle instance directly, via its own domain
   or the VM's IP + Host header, NOT yet through Angular): health
   (`/api/health`, `/actuator/health/readiness`), CORS (a synthetic
   allowed origin in `.env`'s `ALLOWED_ORIGINS`, or none at all —
   real production CORS is not needed until Stage D), session creation,
   idempotency (repeat the SAME `Idempotency-Key` header and confirm the
   same session is returned, not a new one), multi-token authentication
   (resume with a second minted token), resume, answer, review, submit,
   and result — the same checklist `docs/spring-production-runbook.md`
   §5 already uses for Render, run here against Oracle instead.
5. **VM reboot / container restart recovery**: `sudo reboot`, wait, then
   confirm `sudo docker compose -f deploy/oracle/compose.yaml ps` (or
   `sudo ./scripts/health-check.sh`) shows both services healthy again
   with no manual intervention (proves §4.6's restart-policy reasoning
   empirically, not just on paper).
6. **Idle behavior over at least 20 minutes**: unlike Render, an
   always-on VM should show NO cold start at all — confirm a request
   after 20+ minutes of zero traffic responds just as fast as the first
   request after deploy. This is the core hypothesis Oracle is meant to
   validate; do not skip this check.
7. **Confirm no Spring/JVM cold start recurs while the VM remains
   running** — corollary of the above, stated as its own explicit check
   since it is the primary motivation for this migration.
8. **Measure Neon-only idle wake latency separately**: even with Spring
   always warm, Neon's own compute can still sleep independently (§1.10,
   and `docs/spring-production-runbook.md` §4's existing Neon-wake
   measurements). Compare `/api/health` latency (no DB access, should
   stay fast regardless of Neon state) against a DB-touching endpoint's
   latency after a long idle period, ON THE ORACLE INSTANCE, to isolate
   what Oracle actually fixed (Spring's own cold start) from what it did
   NOT (Neon's, which is unaffected by where Spring runs).

### Stage D — Temporary frontend validation

Still no committed production change — Angular's build default stays
pointed at Render throughout.

1. **Test Angular against the Oracle endpoint without changing committed
   defaults**: run `ng serve` locally with a throwaway override — either
   a local, UNCOMMITTED edit to `INTERVIEW_DEV_API_BASE_URL`/the relevant
   token provider, or (equivalently, without touching source at all) a
   browser extension / local proxy that rewrites the Interview API
   origin for a manual test session. Revert any source edit before it is
   ever committed.
2. **CSP/CORS**: if testing via a real browser against the deployed
   Angular bundle (not `ng serve`), a throwaway local build with the
   Oracle origin ADDED to `connect-src` (never REPLACING the Render
   origin) is the reversible way to do this — discard the build, never
   commit or deploy it. On the Oracle side, temporarily set
   `ALLOWED_ORIGINS` in `.env` to include the exact test origin, and
   revert it afterward.
3. **Verify Node/Spring split routing and zero cross-backend fallback**:
   the same proof pattern already established for Render (browser network
   tab — Topic Quiz calls go only to Node, Interview calls go only to
   Spring/Oracle, zero fallback in either direction) — repeat it here
   with Oracle as the Spring target instead of Render.

### Stage E — Production cutover — **APPLIED 2026-09-19**

Applied exactly as follows (approved cutover; Render already validated
live via Stage C's direct-fetch lifecycle proof and Stage D's browser
acceptance test, so Render's origin is REPLACED outright rather than kept
as a temporary CSP duplicate):

1. `src/app/shared/tokens/api-base-url.token.ts`:
   `INTERVIEW_PROD_API_BASE_URL` → `https://interview-api-spring.marvinrusinek.com/api`
   (was `https://interview-api-spring.onrender.com/api`).
2. `src/index.html` CSP `connect-src`: REPLACED
   `https://interview-api-spring.onrender.com` with
   `https://interview-api-spring.marvinrusinek.com` — no duplicate Spring
   origin is retained. A rollback (Stage F) restores the Render origin
   here; it is not kept listed in the interim.
3. Oracle-side CORS: `ALLOWED_ORIGINS` on the VM already includes
   `https://marvinrusinek.github.io` (confirmed during Stage D's browser
   acceptance test) — no VM-side change made or needed by this cutover.
4. `docs/spring-production-runbook.md`: updated the URL references in §1
   and §4 to describe Oracle as the current production Spring host, with
   Render explicitly documented as the intact, unmodified rollback
   target.
5. GitHub Pages rebuild/deploy — the standard `ng build
   --configuration=production && npm run verify:artifact` sequence,
   pushed to `gh-pages`.
6. **No Node endpoint changes** — Node's `PROD_API_BASE_URL` and every
   Topic-Quiz-adjacent path are untouched, exactly as every prior
   Interview-only change in this repository's history has kept Node
   unaffected.

### Stage F — Rollback

If Oracle needs to be rolled back after Stage E's cutover:

1. **Restore the Render Spring base URL and CSP**: revert
   `INTERVIEW_PROD_API_BASE_URL` back to
   `https://interview-api-spring.onrender.com/api`, AND revert the CSP
   `connect-src` entry in `src/index.html` back to
   `https://interview-api-spring.onrender.com` — Stage E (item 2) replaced
   the Render origin outright rather than keeping both listed, so both
   files need the reverting edit, not just the base-URL constant.
2. **Rebuild/deploy GitHub Pages** — same standard sequence as Stage E
   item 5.
3. **Verify Render health and session creation** — repeat
   `docs/spring-production-runbook.md` §5's checklist against Render,
   confirming it still works exactly as it did before the cutover (it
   was never stopped or reconfigured during any of this — see the next
   point).
4. **Avoiding duplicate or incompatible database migrations**: not a
   concern by construction — neither Spring instance (Render's or
   Oracle's) has ever had migration-authoring capability (§1.7, §1.10);
   only Node's `backend/src/db/migrations/` can change the schema, and
   nothing in this migration or its rollback touches that directory or
   runs anything against Neon directly.
5. **Keep Oracle intact for diagnosis** until the rollback itself is
   confirmed working — do not tear down the VM, delete the compose
   project, or remove its data immediately after rolling back; the point
   of keeping it running is to be able to inspect what went wrong.
6. **Do not delete either host** (Render's `interview-api-spring` service
   or the Oracle VM) during the stabilization period following a
   rollback — both remain available until the operator is confident the
   rollback resolved the issue and has decided (as a separate, later,
   explicit decision) what to do with the now-unused host.

---

## 6. Cross-references

- `docs/spring-production-runbook.md` — the current, still-authoritative
  production operations doc; now updated (Stage E) to describe Oracle as
  the current production Spring host, with Render documented as the
  intact rollback target.
- `deploy/oracle/` — the actual deployment package this document
  describes.
- `render.yaml` — the current Render Blueprint; unchanged by this task,
  remains the source of truth for Render's own configuration and the
  rollback target's exact settings.
