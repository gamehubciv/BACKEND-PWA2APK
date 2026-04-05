# ═══════════════════════════════════════════════════════
#  PWA2APK — Dockerfile Railway
#  Base : eclipse-temurin (Java 17 officiel et fiable)
# ═══════════════════════════════════════════════════════
FROM eclipse-temurin:17-jdk-jammy

ENV DEBIAN_FRONTEND=noninteractive
ENV JAVA_HOME=/opt/java/openjdk
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH="${JAVA_HOME}/bin:${PATH}:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/build-tools/34.0.0"

# ── 1. Dépendances système ───────────────────────────
RUN apt-get update && apt-get install -y \
    curl wget unzip git ca-certificates gnupg \
    && rm -rf /var/lib/apt/lists/*

# ── 2. Node 20 ───────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node -v && npm -v

# ── 3. Vérifier Java ─────────────────────────────────
RUN java -version

# ── 4. Android SDK Command-line Tools ───────────────
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
    && wget -q https://dl.google.com/android/repository/commandlinetools-linux-10406996_latest.zip \
         -O /tmp/cmd.zip \
    && unzip -q /tmp/cmd.zip -d /tmp/cmd \
    && mv /tmp/cmd/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
    && rm -rf /tmp/cmd /tmp/cmd.zip

# ── 5. Licences + composants Android ────────────────
RUN yes | ${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager --licenses > /dev/null 2>&1 || true
RUN ${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager \
      "platform-tools" \
      "platforms;android-34" \
      "build-tools;34.0.0"

# ── 6. Bubblewrap CLI ────────────────────────────────
RUN npm install -g @bubblewrap/cli@1.21.1

# ── 7. Config Bubblewrap ─────────────────────────────
RUN mkdir -p /root/.bubblewrap \
    && printf '{\n  "jdkPath": "/opt/java/openjdk",\n  "androidSdkPath": "/opt/android-sdk"\n}\n' \
       > /root/.bubblewrap/config.json

# ── 8. Vérifier bubblewrap ───────────────────────────
RUN bubblewrap --version

# ── 9. App Node.js ───────────────────────────────────
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN mkdir -p /app/tmp

EXPOSE 3000
CMD ["node", "server.js"]
