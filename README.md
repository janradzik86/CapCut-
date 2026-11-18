# ClipForge — edytor wideo (Android · Windows 11 · przeglądarka)

Oryginalny, darmowy edytor wideo inspirowany aplikacjami typu „mobile video editor”.
Nie jest powiązany z żadną inną marką ani nie używa jej grafik czy nazw.

## Gotowe pliki instalacyjne (`dist/`)

| Plik | Platforma |
|---|---|
| `dist/ClipForge-1.0.0-release.apk` | Android 6.0+ (podpisany APK release) |
| `dist/ClipForge-Setup-1.0.0.exe` | Windows 10/11 x64 (instalator NSIS, bez uprawnień administratora) |

**Android:** skopiuj APK na telefon → otwórz → zezwól na „instalację z nieznanych źródeł”.
**Windows 11:** uruchom `ClipForge-Setup-1.0.0.exe` → (SmartScreen: „Więcej informacji” → „Uruchom mimo to”, bo plik nie jest podpisany certyfikatem) → skróty na pulpicie i w menu Start.
Wersja Windows uruchamia edytor w oknie aplikacji silnika Microsoft Edge (WebView wbudowany w Windows 11).

## Funkcje
- Projekty z autozapisem (IndexedDB), lista projektów na ekranie startowym
- Formaty: 9:16, 16:9, 1:1, 4:5, 4:3, 21:9; tło kolor / rozmyte wideo
- Oś czasu: ścieżka główna, nakładki (obraz w obrazie), tekst, audio; zoom, przyciąganie, przycinanie krawędzi, zmiana kolejności przeciąganiem
- Podział, duplikowanie, usuwanie, cofnij/ponów
- Prędkość 0.1×–10×, odtwarzanie wstecz, głośność 0–200 %, wyodrębnianie audio
- 12 filtrów, korekta (jasność, kontrast, nasycenie, odcień, rozmycie, winieta)
- Transformacja (skala, obrót, pozycja, krycie, odbicie), przeciąganie na podglądzie
- Przejścia (przenikanie, wjazd, zoom, rozmycie, obrót), pojawianie/zanikanie obrazu i dźwięku
- Tekst: czcionki, kolory, obrys, etykieta, cień, wyrównanie, animacje (pop, maszyna do pisania…)
- Eksport 480p/720p/1080p, 24/30/60 fps → MP4 (lub WebM, zależnie od urządzenia)

Skróty: Spacja – odtwarzaj, S/B – podziel, Del – usuń, Ctrl+Z/Y – cofnij/ponów, Ctrl+D – duplikuj, ←/→ – klatka.

## Budowanie
```bash
npm install
# Android APK (wymaga Android SDK, JDK 21)
npx cap sync android && cd android && ./gradlew assembleRelease
# Windows Setup (Linux, wymaga mingw-w64 i nsis)
bash windows-lite/build.sh
# Pełna wersja Electron (na Windows)
npx electron-builder --win nsis --x64
```
GitHub Actions (`.github/workflows/build.yml`) buduje APK, instalator „lite” i instalator Electron; po wypchnięciu tagu `v*` publikuje je w GitHub Release.

Własny klucz podpisu Androida: sekrety `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`.
