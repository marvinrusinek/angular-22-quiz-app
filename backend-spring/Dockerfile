# Spring Boot migration target for the Interview backend.
#
# Companion to ../backend/Dockerfile (the Node service that stays the
# production backend and rollback target until this one is cut over — see
# the deployment plan). This image is NOT wired into any Render service yet.
#
# Multi-stage so the runtime image carries no JDK, no Maven distribution, no
# build cache, and no source — only the packaged JAR and a JRE.

# ── build ───────────────────────────────────────────────────────────
# JDK 21 to match <java.version>21</java.version> in pom.xml.
FROM eclipse-temurin:21-jdk-jammy AS build

WORKDIR /app

# Wrapper + POM first: this layer is cached until the wrapper or manifest
# changes, so a source-only edit reuses the resolved dependency tree.
COPY .mvn/ .mvn/
COPY mvnw pom.xml ./
RUN chmod +x mvnw && ./mvnw -B dependency:go-offline

COPY src ./src

# ./mvnw (the Unix shell wrapper), never mvnw.cmd — this stage's base image
# is Linux, and mvnw.cmd is a Windows batch script that would not execute
# here. -DskipTests: unit AND the PostgreSQL Testcontainers integration
# suite (bound to the integration-test/verify phases) are both already
# verified separately against a real disposable Postgres container outside
# Docker; `package` stops before either phase runs, and Testcontainers
# needs a Docker socket this build stage does not have (no Docker-in-Docker
# on Render's build system).
RUN ./mvnw -B clean package -DskipTests

# ── runtime ─────────────────────────────────────────────────────────
# JRE only — no compiler, no Maven, matching the same Java 21 major version.
FROM eclipse-temurin:21-jre-jammy AS runtime

WORKDIR /app

# Wildcard COPY -> fixed destination name: the built JAR's filename embeds
# the Maven artifact version (quiz-backend-<version>.jar), which changes
# over time; renaming it to a single deterministic app.jar here means the
# CMD below never has to track that version.
COPY --from=build /app/target/*.jar app.jar

# Every required setting (SPRING_DATASOURCE_URL/USERNAME/PASSWORD,
# TOPIC_QUIZ_RECEIPT_SECRET, ALLOWED_ORIGINS) is fail-closed with NO
# default in application.properties — deliberately not set here. An image
# that silently booted without them would be worse than one that refuses
# to start; see application.properties for the fail-closed rationale.

# Drop root. The process only needs to read /app and reach the network.
RUN useradd --system --create-home --shell /usr/sbin/nologin appuser
USER appuser

# Documents the local-dev default; Render (like most PaaS hosts) injects
# its own PORT at runtime and server.port=${PORT:8080} binds to it.
EXPOSE 8080

# Plain TCP reachability check — no curl/wget installed in this minimal
# JRE image, and none is added just for this. Confirms the process is
# actually listening; Render's own configured health-check path is the
# real readiness gate (see the deployment plan).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/${PORT:-8080}' || exit 1

CMD ["java", "-jar", "app.jar"]
