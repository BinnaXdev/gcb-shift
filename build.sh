#!/usr/bin/env bash
set -euo pipefail

# 1. organise web files
mkdir -p www assets native
cp index.html style.css app.js i18n.js holidays.js sw.js manifest.json icon-192.png icon-512.png logo.png www/
cp icon-only.png icon-foreground.png icon-background.png assets/
unzip -oq native-parts.zip -d native
cp native/splash.png native/splash-dark.png assets/

# 2. Android project
npm install --no-audit --no-fund
npx cap add android

# 3. fixed signing key (so future updates install over this one)
mkdir -p "$HOME/.android"
cp native/gcb-debug.keystore "$HOME/.android/debug.keystore"

# 4. native parts: widget, plugin, notification icon
PKG=android/app/src/main/java/com/gcb/shift
RES=android/app/src/main/res
mkdir -p "$PKG" "$RES/layout" "$RES/xml" "$RES/drawable"
cp native/GcbWidgetProvider.java native/GcbWidgetPlugin.java native/MainActivity.java "$PKG/"
cp native/widget_gcb.xml "$RES/layout/"
cp native/gcb_widget_info.xml "$RES/xml/"
cp native/widget_bg.xml native/ic_stat_gcb.xml "$RES/drawable/"
python3 native/patch_manifest.py android/app/src/main/AndroidManifest.xml

# 5. icons + splash, sync, build
npx capacitor-assets generate --android
npx cap sync android
cd android
chmod +x gradlew
./gradlew assembleDebug --no-daemon
