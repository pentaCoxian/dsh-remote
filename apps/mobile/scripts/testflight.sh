#!/bin/sh
# Build the iOS app and upload it to App Store Connect for TestFlight.
#
#   scripts/testflight.sh          # build number: commits on HEAD (always increasing on main)
#   BUILD_NUMBER=57 scripts/testflight.sh
#
# Xcode signs (automatic, team KFQ3CFVZ3D) and uploads with the Apple ID it is signed in to.
# Flutter archives; xcodebuild uploads, since `flutter build ipa` with an upload destination
# finds no .ipa afterwards and crashes.
set -eu
cd "$(dirname "$0")/.."
build=${BUILD_NUMBER:-$(git rev-list --count HEAD)}

./native/build.sh ios
flutter build ipa --release --build-number "$build"
xcodebuild -exportArchive \
  -archivePath build/ios/archive/Runner.xcarchive \
  -exportOptionsPlist ios/ExportOptions.plist \
  -exportPath build/ios/upload \
  -allowProvisioningUpdates
echo "uploaded build $build; App Store Connect emails when it has processed"
