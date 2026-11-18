#!/usr/bin/env bash
# Generates deterministic test media into $1 (default www/_test). Needs ffmpeg, imagemagick, espeak-ng (optional).
set -euo pipefail
D=${1:-www/_test}; mkdir -p "$D"
ffmpeg -loglevel error -y -f lavfi -i testsrc2=size=640x360:rate=30 -f lavfi -i "sine=frequency=440" -t 6 -c:v libvpx -c:a libopus "$D/clip.webm"
ffmpeg -loglevel error -y -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i "sine=f=880:d=5" -t 5 -c:v libx264 -pix_fmt yuv420p -c:a aac "$D/h264.mp4"
ffmpeg -loglevel error -y -f lavfi -i "sine=f=220:d=12" -ac 2 -c:a libmp3lame "$D/music.mp3"
for c in red green blue; do ffmpeg -loglevel error -y -f lavfi -i "color=c=$c:s=800x600:d=1" -frames:v 1 "$D/$c.png"; done
curl -fsSL -o "$D/person.png" https://storage.googleapis.com/mediapipe-assets/business-person.png || true
if command -v espeak-ng >/dev/null; then
  espeak-ng -v pl -s 140 -w "$D/speech_pl.wav" "Dzień dobry. To jest test automatycznych napisów w aplikacji."
  espeak-ng -v en -s 150 -w "$D/speech_en.wav" "Hello everyone. This is a test of automatic subtitles."
fi
ls -la "$D"
