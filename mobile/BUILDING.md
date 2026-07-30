# Building AFK Desk Mobile

## Android

The release configuration supports ARM64 and 32-bit ARM devices running Android 7.0 or newer.

Install JDK 17, Android SDK Platform 35, Build Tools 35.0.0, NDK 26.1.10909125, and CMake 3.22.1. Then run:

```powershell
npm ci
cd nodejs-assets/nodejs-project
npm ci --omit=dev
cd ../../android
./gradlew assembleRelease
```

On Windows, use a short checkout path because the embedded Node C++ build can exceed the traditional path-length limit. Configure your own release signing key before distributing builds; the repository does not contain production signing credentials.

## iPhone and iPad

Apple builds require macOS, Xcode, CocoaPods, and an Apple development team:

```bash
npm ci
cd nodejs-assets/nodejs-project && npm ci --omit=dev && cd ../..
cd ios && pod install
```

Open `ios/AFKDeskMobile.xcworkspace`, select your development team, and run on your device. Apple requires signing even for personal installations. iOS may suspend Minecraft sockets after the app is backgrounded, so reliable continuous background operation is Android-only.
