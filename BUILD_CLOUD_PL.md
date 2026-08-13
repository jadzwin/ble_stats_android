# Najprostsza kompilacja APK bez Android Studio

Projekt ma dwie gotowe ścieżki budowania w chmurze.

## Opcja A — GitHub Actions

1. Utwórz puste repozytorium na GitHubie.
2. Prześlij do niego całą zawartość tego katalogu, łącznie z ukrytym katalogiem `.github`.
3. Wejdź w zakładkę **Actions**.
4. Wybierz **Build Android APK**.
5. Kliknij **Run workflow**.
6. Po zakończeniu otwórz wykonanie i pobierz artefakt **ECUMaster-BLE-RX-Stats-APK**.
7. W ZIP-ie artefaktu znajduje się instalowalny plik `ECUMaster-BLE-RX-Stats.apk`.

Workflow wykonuje kompilację wariantu `release`, więc aplikacja jest samodzielna i nie wymaga Metro ani komputera podczas testu.

## Opcja B — Expo EAS Build

Po zalogowaniu do konta Expo, w katalogu projektu:

```bash
npm install
npx eas-cli build --platform android --profile preview
```

Profil `preview` w `eas.json` generuje APK przeznaczone do instalacji bez Google Play.

## Po instalacji

Android może wymagać zgody na instalację aplikacji z wybranego źródła. Następnie uruchom aplikację, udziel uprawnień Bluetooth i naciśnij **Połącz i testuj**.
