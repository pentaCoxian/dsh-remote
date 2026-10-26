#!/bin/sh
# Build the phone pipe (dshr_pipe) into the Flutter app:
#   ios      -> ios/Frameworks/DshrPipe.xcframework (dynamic framework, device + Apple-silicon simulator)
#   android  -> android/app/src/main/jniLibs/<abi>/libdshr_pipe.so (arm64-v8a, armeabi-v7a, x86_64)
#
#   apps/mobile/native/build.sh [ios|android|all]   (default: all)
#
# iOS gets a dynamic framework, not the static archive: with LTO the archive
# holds rustc's LLVM bitcode, which Xcode's older LLVM cannot link.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
app=$(cd "$here/.." && pwd)
crate="$here/dshr_pipe"
what=${1:-all}

# rustup's toolchains (with the mobile targets), ahead of any Homebrew `rust`.
if command -v brew >/dev/null 2>&1 && [ -d "$(brew --prefix rustup 2>/dev/null)/bin" ]; then
  PATH="$(brew --prefix rustup)/bin:$PATH"
fi
PATH="$HOME/.cargo/bin:$PATH"
export PATH

MIN_IOS=17.5
ANDROID_API=24

build_ios() {
  export IPHONEOS_DEPLOYMENT_TARGET=$MIN_IOS
  work="$crate/target/xcframework"
  rm -rf "$work" "$app/ios/Frameworks/DshrPipe.xcframework"
  args=""
  for target in aarch64-apple-ios aarch64-apple-ios-sim; do
    (cd "$crate" && cargo build --release --target "$target")
    case $target in *-sim) platform=iPhoneSimulator ;; *) platform=iPhoneOS ;; esac
    framework="$work/$target/DshrPipe.framework"
    mkdir -p "$framework"
    cp "$crate/target/$target/release/libdshr_pipe.dylib" "$framework/DshrPipe"
    install_name_tool -id @rpath/DshrPipe.framework/DshrPipe "$framework/DshrPipe"
    cat > "$framework/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>DshrPipe</string>
  <key>CFBundleIdentifier</key><string>dev.dshremote.DshrPipe</string>
  <key>CFBundleName</key><string>DshrPipe</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleSupportedPlatforms</key><array><string>$platform</string></array>
  <key>MinimumOSVersion</key><string>$MIN_IOS</string>
</dict>
</plist>
PLIST
    args="$args -framework $framework"
  done
  mkdir -p "$app/ios/Frameworks"
  # shellcheck disable=SC2086
  xcodebuild -create-xcframework $args -output "$app/ios/Frameworks/DshrPipe.xcframework" >/dev/null
  echo "built $app/ios/Frameworks/DshrPipe.xcframework"
}

build_android() {
  sdk=${ANDROID_HOME:-$HOME/Library/Android/sdk}
  export ANDROID_NDK_HOME=${ANDROID_NDK_HOME:-$(ls -d "$sdk"/ndk/* | sort -V | tail -1)}
  # 16 KB pages (required by Play for 64-bit ABIs); NDK r28+ does this by default.
  export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384"
  export CARGO_TARGET_X86_64_LINUX_ANDROID_RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384"
  staging="$crate/target/jniLibs"
  rm -rf "$staging"
  (cd "$crate" && cargo ndk --platform $ANDROID_API -t arm64-v8a -t armeabi-v7a -t x86_64 -o "$staging" build --release)
  for abi in arm64-v8a armeabi-v7a x86_64; do
    mkdir -p "$app/android/app/src/main/jniLibs/$abi"
    # cargo-ndk also copies dependency cdylibs; only the pipe ships.
    cp "$staging/$abi/libdshr_pipe.so" "$app/android/app/src/main/jniLibs/$abi/"
  done
  echo "built $app/android/app/src/main/jniLibs/{arm64-v8a,armeabi-v7a,x86_64}/libdshr_pipe.so (NDK $(basename "$ANDROID_NDK_HOME"))"
}

case $what in
  ios) build_ios ;;
  android) build_android ;;
  all) build_ios && build_android ;;
  *) echo "usage: $0 [ios|android|all]" >&2; exit 2 ;;
esac
