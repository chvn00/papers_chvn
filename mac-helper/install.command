#!/bin/zsh
set -euo pipefail

helper_dir="${0:A:h}"
apps_dir="${HOME}/Applications"
app_path="${apps_dir}/Papers CHVN Folder Opener.app"
plist_path="${app_path}/Contents/Info.plist"
lsregister_path="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

mkdir -p "${apps_dir}"
if [[ -e "${app_path}" ]]; then
  rm -rf "${app_path}"
fi

/usr/bin/osacompile -l AppleScript -o "${app_path}" "${helper_dir}/PapersCHVNFolderOpener.applescript"
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.chvn.papers.folderopener" "${plist_path}"
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Papers CHVN Folder Opener" "${plist_path}"
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "${plist_path}"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" "${plist_path}"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0 dict" "${plist_path}"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLName string com.chvn.papers.folderopener" "${plist_path}"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "${plist_path}"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string papers-chvn" "${plist_path}"
/usr/bin/codesign --force --deep --sign - "${app_path}"
"${lsregister_path}" -f "${app_path}"

echo "Papers CHVN Folder Opener quedó instalado. Ya puedes abrir carpetas desde las tarjetas."
