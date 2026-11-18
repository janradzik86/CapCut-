# ClipForge 2 — edytor wideo z AI offline (Android · Windows 10/11)

Oryginalny edytor wideo z silnikami AI działającymi **lokalnie na urządzeniu** (bez chmury i bez internetu).
Nie jest powiązany z żadną inną marką.

## Pobieranie
Gotowe instalatory są w zakładce **Releases** repozytorium (budowane i testowane automatycznie przez GitHub Actions):

| Plik | Platforma |
|---|---|
| `ClipForge-2.0.0-release.apk` | Android 6.0+ (podpisany APK release) |
| `ClipForge-Setup-2.0.0.exe` | Windows 10/11 x64 (instalator, bez uprawnień administratora) |

Każde wydanie przechodzi: test E2E w Chromium (Linux) oraz pełny test na Windows (cicha instalacja →
uruchomienie w Microsoft Edge → eksport MP4 → weryfikacja pliku w `Wideo\ClipForge` → deinstalacja).

## Silniki AI dołączone do aplikacji
| Silnik | Zastosowanie | Rozmiar |
|---|---|---|
| Whisper base (ONNX q8, transformers.js) | Automatyczne napisy, transkrypcja, SRT | ~80 MB |
| MediaPipe Selfie Segmenter | Usuwanie / rozmycie / zamiana tła w wideo (czas rzeczywisty) | 0,25 MB |
| MediaPipe Selfie Multiclass | Precyzyjne tło na zdjęciach (włosy, skóra, ubrania) | 16 MB |
| MediaPipe Face Landmarker (478 pkt) | Retusz: wygładzanie skóry, oczy, rozjaśnienie | 3,6 MB |
| MediaPipe BlazeFace | Inteligentne oświetlenie, kadrowanie 9:16, ocena ujęć | 0,2 MB |
| DSP (własne) | Wykrywanie rytmu (automontaż), wycinanie ciszy, auto-ulepszanie, efekty | — |

## Najważniejsze funkcje
- **Eksport klatka po klatce** (WebCodecs): MP4 H.264 + AAC (lub Opus), stała liczba klatek, 480p–4K, 24–60 kl/s,
  miks audio offline (głośności, zanikanie, zmiana prędkości z zachowaniem wysokości dźwięku, odtwarzanie wstecz).
- **Zapis**: Android → Galeria (`Filmy/ClipForge`, `Obrazy/ClipForge`), Windows → `Wideo\ClipForge`, `Obrazy\ClipForge`.
- **Dopasowanie do długości audio**: zdjęcia automatycznie dzielą czas muzyki (każde kolejne skraca poprzednie),
  wideo zachowuje oryginalną długość, a gdy brak zdjęć — wideo jest powielane do końca muzyki.
- **Głośność**: osobno dźwięk z wideo i muzyka (0–200 %), wyciszenie jednym kliknięciem, głośność każdego klipu.
- Oś czasu z 4 ścieżkami, podział, przycinanie, prędkość, filtry, korekta, przejścia, tekst z animacjami,
  szablony, automontaż w rytm muzyki, kolaż, okładki, aparat, teleprompter, nagrywanie lektora.

## Budowanie
```bash
npm install
bash scripts/fetch-ai.sh                      # silniki i modele AI → www/ai
npx cap sync android && cd android && ./gradlew assembleRelease   # APK
bash windows-lite/build.sh                    # instalator Windows (mingw-w64 + nsis)
node tests/e2e.js http://localhost:8123/ _test/ out --whisper     # test E2E
```
Własny klucz podpisu Androida: sekrety `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`.
