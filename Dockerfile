FROM eclipse-temurin:17-jdk-jammy

ENV DEBIAN_FRONTEND=noninteractive
ENV JAVA_HOME=/opt/java/openjdk
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH="${JAVA_HOME}/bin:${PATH}:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/build-tools/35.0.0:${ANDROID_HOME}/build-tools/34.0.0"

# ── 1. Dépendances système ────────────────────────────────────
RUN apt-get update && apt-get install -y \
    curl wget unzip git ca-certificates gnupg \
    && rm -rf /var/lib/apt/lists/*

# ── 2. Node 20 ───────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node -v && npm -v

# ── 3. Android SDK cmdline-tools v9 (compatible bubblewrap 1.21) ─
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
    && wget -q https://dl.google.com/android/repository/commandlinetools-linux-9477386_latest.zip \
         -O /tmp/cmd.zip \
    && unzip -q /tmp/cmd.zip -d /tmp/cmd \
    && mv /tmp/cmd/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest \
    && rm -rf /tmp/cmd /tmp/cmd.zip

# ── 4. Accepter toutes les licences ──────────────────────────
RUN yes | ${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager --licenses > /dev/null 2>&1 || true

# ── 5. Installer TOUS les SDK dont Gradle a besoin ───────────
# On pré-installe 34 ET 35 + platform 34 ET 36 pour éviter
# que Gradle les télécharge pendant le build (lent + RAM gaspillée)
RUN ${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager \
      "platform-tools" \
      "platforms;android-34" \
      "platforms;android-36" \
      "build-tools;34.0.0" \
      "build-tools;35.0.0"

# ── 6. Vérification SDK ──────────────────────────────────────
RUN ${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager --version \
    && ls ${ANDROID_HOME}/platforms/ \
    && ls ${ANDROID_HOME}/build-tools/

# ── 7. Bubblewrap CLI ────────────────────────────────────────
RUN npm install -g @bubblewrap/cli@1.21.0

# ── 8. Config Bubblewrap avec sdkManagerPath explicite ───────
RUN mkdir -p /root/.bubblewrap && cat > /root/.bubblewrap/config.json << 'BWEOF'
{
  "jdkPath": "/opt/java/openjdk",
  "androidSdkPath": "/opt/android-sdk",
  "sdkManagerPath": "/opt/android-sdk/cmdline-tools/latest/bin/sdkmanager"
}
BWEOF

# ── 9. Vérification bubblewrap ───────────────────────────────
RUN bubblewrap --version

# ── 10. Pré-télécharger Gradle 8.11.1 pour éviter le DL au runtime ─
# Gradle est téléchargé par le wrapper au premier build — on le cache
# dans l'image Docker pour ne pas le re-télécharger à chaque job.
RUN mkdir -p /root/.gradle/wrapper/dists

# ── 11. App Node.js ──────────────────────────────────────────
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN mkdir -p /app/tmp

EXPOSE 3000
CMD ["node", "server.js"]
