"""Local Whisper transcription server for Mock Interview Copilot's
"capture call audio" feature.

Run: python transcribe_server.py
Install deps first: pip install -r requirements-transcribe.txt
For GPU acceleration (recommended if you have an NVIDIA card): also
pip install -r requirements-transcribe-gpu.txt

Exposes an OpenAI-shaped /v1/audio/transcriptions endpoint (multipart
"file" field in, {"text": "..."} out) matching what server.js's
/api/transcribe proxy already sends. Binds to 127.0.0.1 only.
"""
import os
import sys
import tempfile

from dotenv import load_dotenv
load_dotenv()  # reads the same .env server.js uses, so config lives in one place

# ctranslate2 (faster-whisper's backend) needs cuBLAS/cuDNN's DLLs to use
# the GPU. On Windows, pip-installed nvidia-cublas-cu12/nvidia-cudnn-cu12
# land in site-packages rather than on PATH, so Windows can't find them
# without this. If they're not installed (no GPU, or GPU deps skipped),
# this is a no-op and WHISPER_DEVICE should be left as "cpu".
if sys.platform == "win32":
    try:
        import nvidia.cublas
        import nvidia.cudnn
        os.add_dll_directory(os.path.join(nvidia.cublas.__path__[0], "bin"))
        os.add_dll_directory(os.path.join(nvidia.cudnn.__path__[0], "bin"))
    except ImportError:
        pass

from flask import Flask, request, jsonify
from faster_whisper import WhisperModel

# distil-large-v3 is the sweet spot: near large-v3 accuracy, several times
# faster, and light on VRAM (~1.5GB) — easily coexists with a large LLM
# also loaded on the same GPU. tiny/base/small/medium/large-v3 also work;
# bigger is slower but more accurate. First run downloads the chosen model.
# `or` (not a dict-get default) so a blank value in .env — not just a
# missing one — still falls back to the default, matching how server.js
# treats its own env vars.
MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE") or "distil-large-v3"
DEVICE = os.environ.get("WHISPER_DEVICE") or "cuda"
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE") or ("float16" if DEVICE == "cuda" else "int8")
PORT = int(os.environ.get("WHISPER_PORT") or "8000")

print(f"Loading Whisper model '{MODEL_SIZE}' on {DEVICE} (first run downloads it)...")
try:
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
except Exception as e:
    if DEVICE == "cuda":
        print(f"GPU load failed ({e}); falling back to CPU. For GPU acceleration, "
              f"see requirements-transcribe-gpu.txt in the README.")
        DEVICE, COMPUTE_TYPE = "cpu", "int8"
        model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
    else:
        raise
print(f"Model loaded on {DEVICE} ({COMPUTE_TYPE}). Listening on http://127.0.0.1:{PORT}")

app = Flask(__name__)


# Flask's default error page for an unhandled exception is HTML, and
# server.js expects JSON back from this server — an HTML response there
# just shows up as a confusing "not valid JSON" error with no indication
# of what actually went wrong. Route every failure through JSON instead,
# with the real exception message included, so this is diagnosable.
@app.errorhandler(Exception)
def handle_error(err):
    return jsonify({"error": {"message": str(err)}}), 500


@app.route("/v1/audio/transcriptions", methods=["POST"])
def transcribe():
    if "file" not in request.files:
        return jsonify({"error": {"message": "No 'file' field in request."}}), 400

    upload = request.files["file"]
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
        upload.save(tmp.name)
        tmp_path = tmp.name

    try:
        # vad_filter skips silence/noise instead of transcribing (or
        # hallucinating words from) it — real call audio has a lot more
        # dead air and background noise than a clean test clip.
        segments, _ = model.transcribe(
            tmp_path, beam_size=5, vad_filter=True, language="en"
        )
        text = "".join(segment.text for segment in segments).strip()
    finally:
        os.remove(tmp_path)

    return jsonify({"text": text})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=PORT)
