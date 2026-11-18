#!/usr/bin/env bash
# Vendors the on-device AI engines + model weights into www/ai so they ship inside the APK / EXE.
# Sources: npm packages (@huggingface/transformers, @mediapipe/tasks-vision),
#          Google MediaPipe model storage, Hugging Face (onnx-community/whisper-*).
set -uo pipefail
cd "$(dirname "$0")/.."
AI=www/ai; mkdir -p $AI/lib/mediapipe $AI/models
NM=node_modules
cp $NM/@huggingface/transformers/dist/transformers.min.js $AI/lib/transformers.min.js
cp $NM/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.{mjs,wasm} $AI/lib/
cp $NM/@mediapipe/tasks-vision/vision_bundle.mjs $AI/lib/mediapipe/
cp $NM/@mediapipe/tasks-vision/wasm/vision_wasm_internal.{js,wasm} $AI/lib/mediapipe/
cp $NM/@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.{js,wasm} $AI/lib/mediapipe/

get() { # url dest
  [ -s "$2" ] && return 0
  mkdir -p "$(dirname "$2")"
  for i in 1 2 3 4; do curl -fsSL --retry 2 -o "$2.part" "$1" && mv "$2.part" "$2" && return 0; sleep $((i*3)); done
  rm -f "$2.part"; echo "WARN: could not download $1" >&2; return 1
}
MP=https://storage.googleapis.com/mediapipe-models
get $MP/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite $AI/models/selfie_multiclass_256x256.tflite
get $MP/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite $AI/models/selfie_segmenter.tflite
get $MP/face_landmarker/face_landmarker/float16/1/face_landmarker.task $AI/models/face_landmarker.task
get $MP/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite $AI/models/blaze_face_short_range.tflite

WHISPER=${WHISPER_MODEL:-whisper-base}
HF=https://huggingface.co/onnx-community/$WHISPER/resolve/main
ok=1
for f in config.json generation_config.json preprocessor_config.json tokenizer.json tokenizer_config.json \
         onnx/encoder_model_quantized.onnx onnx/decoder_model_merged_quantized.onnx; do
  get $HF/$f $AI/models/$WHISPER/$f || ok=0
done
if [ $ok = 1 ]; then echo "{\"whisper\":\"$WHISPER\"}" > $AI/models/manifest.json
else rm -rf $AI/models/$WHISPER; echo '{"whisper":null}' > $AI/models/manifest.json; echo "WARN: Whisper model not bundled" >&2; fi
du -sh $AI/lib $AI/models
