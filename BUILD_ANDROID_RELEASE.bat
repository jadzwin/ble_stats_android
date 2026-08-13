@echo off
setlocal
where node >nul 2>nul || (
  echo Brak Node.js w PATH.
  exit /b 1
)
call npm install || exit /b 1
call npx expo prebuild --clean --platform android || exit /b 1
cd android
call gradlew.bat assembleRelease --no-daemon || exit /b 1
echo.
echo APK: android\app\build\outputs\apk\release\app-release.apk
endlocal
