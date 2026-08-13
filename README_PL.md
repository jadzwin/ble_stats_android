# ECUMaster BLE RX Stats

Minimalna aplikacja diagnostyczna dla Androida oparta na `react-native-ble-plx`.
Jej jedynym zadaniem jest sprawdzić, ile notyfikacji i ramek BLE dociera do prostej aplikacji React Native bez rozbudowanego UI, zapisu logów i operacji TX.

## Co robi

- skanuje w trybie `ScanMode.LowLatency`;
- szuka urządzenia `EMULOGGER` lub MAC `98:DA:20:07:E0:AC`;
- łączy się z `autoConnect=false`;
- żąda `ConnectionPriority.High`;
- żąda MTU 247 i pokazuje wartość zwróconą przez bibliotekę;
- preferuje usługę FFE0 i charakterystykę notify FFE1, z fallbackiem do pierwszej charakterystyki notify/indicate;
- odbiera dane bez wykonywania zapisów do modułu;
- nie wykonuje `setState`, `console.log` ani zapisu do pliku dla każdej notyfikacji;
- aktualizuje UI tylko co 500 ms;
- parsuje ramki `[id, 163, high, low, checksum]`, również gdy ramka zostanie podzielona pomiędzy callbackami;
- liczy długości notyfikacji, B/s, callbacki/s, ramki/s, błędy checksum, resynchronizację i duplikaty;
- zbiera statystyki RPM, IAT i CLT oraz liczbę wystąpień każdego ID;
- mierzy czas callbacku i opóźnienia pętli JS;
- generuje raport tekstowy przez systemowe „Udostępnij”.

## Najprostsze zbudowanie APK bez własnego toolchainu

Zobacz [BUILD_CLOUD_PL.md](BUILD_CLOUD_PL.md). Repozytorium zawiera gotowy workflow:

```text
.github/workflows/android-apk.yml
```

Po ręcznym uruchomieniu GitHub Actions wynikowym artefaktem jest samodzielny APK w wariancie `release`.

Alternatywnie `eas.json` zawiera profil Expo EAS `preview`, który również generuje APK.

## Budowanie lokalne

Wymagane: Node.js, JDK i Android SDK.

```bash
npm install
npx expo prebuild --clean --platform android
cd android
./gradlew assembleRelease
```

Na Windows można uruchomić `BUILD_ANDROID_RELEASE.bat`.

## Zmiana modułu lub UUID

Edytuj `src/config.ts`:

```ts
targetDeviceName: 'EMULOGGER',
targetDeviceId: '98:DA:20:07:E0:AC',
preferredServiceUuid: '0000ffe0-0000-1000-8000-00805f9b34fb',
preferredNotifyCharacteristicUuid: '0000ffe1-0000-1000-8000-00805f9b34fb',
```

Dla źródła użytego w dotychczasowych testach oczekiwane jest około 25 Hz dla RPM oraz 6,25 Hz dla IAT i CLT, czyli RPM/CLT około 4,0 i IAT/CLT około 1,0.

Dokładny pomiar utraty pakietów wymaga licznika sekwencyjnego po stronie modułu. Bez niego aplikacja szacuje dostarczenie na podstawie oczekiwanych częstotliwości kanałów.
