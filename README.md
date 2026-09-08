# Mock Interview Copilot

A practice tool for school mock coding interviews. Two real people — a
student and a peer or coach — sit at one screen together. The tool gives
live coaching insights and correctness/complexity feedback during the
practice attempt, then a structured debrief afterward.

## What it is

The UI is a single self-contained HTML file:
[mock-interview-copilot.html](mock-interview-copilot.html) — vanilla
JavaScript, no build step, no framework. It's paired with one small
Node script, [server.js](server.js), that serves the page, supplies
initial settings from a local config file, proxies local-model calls,
and (only for the Claude Code provider) bridges to the CLI. An optional
second process, [transcribe_server.py](transcribe_server.py), adds
speech-to-text for the other person's voice on a call. No database, no
external backend service — see "Running it" below for exactly what to
start.

## Features

There's no problem-statement box or code editor — everything the Coach
panel knows comes from the spoken transcript. The problem, the
approach, any code talked through out loud: all of it has to actually
be said for the model to work with it. That's a deliberate tradeoff for
a tool meant to sit alongside a real conversation, not a text editor.

- **Live transcription** — uses the browser's `SpeechRecognition` /
  `webkitSpeechRecognition` API (Chrome/Edge only) to transcribe your
  own microphone. Auto-restarts while toggled on. Shows interim and
  final results as they arrive. This transcript is the entire input to
  every coach mode below — the fuller it is, the better the answers.
- **Call audio capture** — separately, "Capture call audio" picks up
  the *other* person's voice from a video-call browser tab (Google
  Meet, Teams web, Zoom web, etc.) into the same transcript, tagged
  `[other speaker]`. See "Call audio capture" below for how this works
  and what it needs.
- **Session timer** — start/pause.
- **Coach panel** — four tabbed modes, each reasoning purely from the
  transcript so far and sending a distinct prompt to the model,
  "Solve" first and active by default:
  - **Solve** — a full example answer written in first person, as if a
    strong candidate were speaking it out loud: approach, reasoning,
    code walkthrough, edge cases, complexity. A model script to study
    from, not a hint.
  - **Hint** — a nudge, never the full answer.
  - **Correctness** — checks the described approach against the
    problem discussed in the transcript.
  - **Complexity** — reports time/space Big-O and a possible
    improvement, based on what's been said.

  Every mode is told to say so plainly, rather than guess, if the
  transcript so far doesn't give it enough to go on.

  For local models that expose separate chain-of-thought (e.g. Qwen3's
  `reasoning_content`), only the final answer is ever shown — the
  reasoning stays server-side and never reaches the page, even as a
  fallback.
- **Auto-answer on pause** — on by default. After the candidate goes
  quiet for ~4 seconds (and has said something new since the last
  answer), the Solve prompt runs on its own and its answer appears in
  the Coach panel — no click needed. Same visibility as a manual click:
  it writes to the same on-screen panel both people are already
  watching, nothing happens off-screen. Toggle it off to go back to
  manual-only.
- **Live coaching strip** — a separate opt-in toggle (off by default),
  for a much smaller/cheaper signal than full auto-answers. Watches the
  transcript for changes, waits for a 2.5s idle pause, and rate-limits
  itself to one call per 12 seconds. Produces a glanceable nudge of 15
  words or fewer. Never gives a full solution.
- **End-of-session debrief** — a structured scorecard (approach,
  correctness, communication, one strength, one improvement, suggested
  next problem type) built from the full session context.
- **Session log** — a running list of every coach and live-coaching
  request, with a truncated response for each.
- **Model provider switch** — choose one of three sources for coach
  responses:
  - **Claude (cloud API)** — calls `api.anthropic.com` directly from the
    browser using an API key you enter in the page (kept in page memory
    only, never persisted).
  - **Local model (LM Studio)** — sends OpenAI-chat-completions-format
    requests (default endpoint `http://localhost:1234/v1/chat/completions`,
    default model `qwen/qwen3.8-27b`) through `server.js`, which forwards
    them to LM Studio with the bearer token attached server-side. This
    has to be proxied rather than called directly from the browser: LM
    Studio's auth token requirement also applies to the CORS preflight
    request, so a browser sending a custom `Authorization` header can
    never get past preflight to reach it directly.

    The proxy also sends `reasoning_effort: "none"` on every request.
    For reasoning models (Qwen3 and similar), this was benchmarked as
    the single biggest speed lever available: on this app's actual
    prompts, reasoning tokens were regularly 40-70% of everything
    generated — pure latency with no user-visible benefit, since that
    reasoning is never shown. Disabling it took a real "Solve" answer
    from 24.2s to 12.9s on the same model with no drop in answer
    quality. Models that don't support the field just ignore it, so
    this is safe to leave on regardless of which model is loaded.

    Quantization matters too, but less: switching the same model from
    Q6_K to Q4_K_M (both with reasoning off) was an additional ~18%
    faster (12.9s → 10.5s), for a combined ~2.3x speedup over the
    original config. Q4_K_M is the better default for this app —
    noticeably lighter on disk/VRAM with no perceptible quality loss in
    testing — but going lower than that trades away real accuracy, so
    it isn't a knob to keep turning.
  - **Claude Code (VS Code subscription)** — also routes through
    `server.js`, which keeps one persistent Claude Code CLI session open
    for the whole practice session (instead of spawning a CLI process
    per question), so it authenticates with your Claude Code/VS Code
    subscription login instead of API-key billing. See below.

  Every field in the settings bar can be typed in directly. `server.js`
  additionally prefills them on page load from a local config file (see
  Configuration below) — that's a convenience, not a requirement.

## Running it

### First-time setup

```bash
# 1. Config — copy the template and fill in real values (.env is gitignored)
cp .env.example .env

# 2. Only needed if you'll use "Capture call audio" — installs the local
#    Whisper transcription server's Python dependencies
pip install -r requirements-transcribe.txt

# 3. Optional, but strongly recommended if you have an NVIDIA GPU — GPU
#    inference is both faster and lets you use a far more accurate model
#    than is practical on CPU. Skip this and it just runs on CPU instead.
pip install -r requirements-transcribe-gpu.txt
```

See Configuration below for what goes in `.env`.

### Every time you run a practice session

```bash
node server.js
```

Then visit `http://localhost:8080` (or whatever `PORT` is set to in
`.env`). That one command serves the page and handles config prefill,
the local-model proxy, and the Claude Code bridge.

If you also want **"Capture call audio"** to work, start the second,
separate process alongside it (order doesn't matter, but both need to
be running):

```bash
python transcribe_server.py
```

That's everything — two processes total, both on `localhost` only:
`node server.js` (port `8080` by default) for the app itself, and
`python transcribe_server.py` (port `8000` by default) purely for
transcribing the other person's voice from a call tab. Skip the second
one if you don't need that feature.

### What needs which process

| Provider / feature | Needs `node server.js`? | Needs `transcribe_server.py`? |
|---|---|---|
| Claude (cloud API) | No — works from the HTML file directly | No |
| Local model (LM Studio) | Yes | No |
| Claude Code (VS Code subscription) | Yes (+ Claude Code CLI installed & logged in) | No |
| Your own mic transcript | No | No |
| Capture call audio (other speaker) | Yes | Yes |

Only the Claude (cloud API) provider works by opening
[mock-interview-copilot.html](mock-interview-copilot.html) directly
with no server running at all — everything else needs `server.js`, and
call audio capture additionally needs `transcribe_server.py`.

## Configuration

`.env` (copied from [.env.example](.env.example) in first-time setup
above) is gitignored, so real secrets placed there are never
committed:

| Variable | Purpose |
|---|---|
| `PORT` | Port `server.js` listens on (default `8080`). |
| `CLAUDE_API_KEY` | Prefills the Claude API key field. |
| `LMSTUDIO_URL` | Prefills the LM Studio endpoint URL. |
| `LMSTUDIO_MODEL` | Prefills the LM Studio model name. |
| `LMSTUDIO_TOKEN` | Prefills the LM Studio bearer token. |
| `BRIDGE_TOKEN` | Pins the Claude Code bridge token instead of a fresh random one each run. |
| `WHISPER_URL` | Whisper-compatible transcription server for call audio capture (default `http://localhost:8000/v1/audio/transcriptions`). |
| `WHISPER_MODEL` | Model name sent to that server (default `whisper-1`). |
| `WHISPER_TOKEN` | Optional bearer token for that server. |

Every one of these is still editable in the page itself after it
loads — `.env` only sets what shows up when the page opens.

### Call audio capture

"Capture call audio" (next to the mic button) is for picking up the
*other person's* voice — from a Google Meet, Teams-web, or Zoom-web tab
— without a virtual audio cable and without touching your normal
speaker output. It works like this:

1. Click it. Chrome/Edge prompts you to share a tab, window, or
   screen — pick the call's browser tab and check **"Share tab
   audio."**
2. This grabs a *copy* of that tab's audio via `getDisplayMedia` — your
   speakers keep playing it exactly as before, nothing is rerouted or
   silenced.
3. Every 5 seconds, the captured audio is sent to `server.js`, which
   forwards it to a Whisper-compatible transcription server (an
   OpenAI-style `/v1/audio/transcriptions` endpoint) and appends the
   result into the transcript, tagged `[other speaker]`.

This is why it needs a transcription server: the browser's built-in
`SpeechRecognition` (used for your own mic) can only ever listen to the
real OS microphone — there's no way to point it at an arbitrary audio
stream, so a real speech-to-text server is required for anyone else's
voice.

This repo includes one: [transcribe_server.py](transcribe_server.py),
a small local server using
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) (no
Docker, no torch required). See "Running it" above for setup — in
short, `pip install -r requirements-transcribe.txt` once, then
`python transcribe_server.py` alongside `node server.js` each session.

**GPU vs CPU:** it defaults to `distil-large-v3` on `cuda` — a model
that's close to full `large-v3` accuracy, several times faster than
running on CPU, and light enough on VRAM (~2.5GB) to comfortably share
a GPU with a large LLM already loaded (e.g. a 27B model in LM Studio).
If `requirements-transcribe-gpu.txt` isn't installed, or there's no
usable GPU, it automatically falls back to CPU (`int8`) — slower, and
`base` or `small` are the only realistic model sizes at real-time
speed on CPU. Set `WHISPER_MODEL_SIZE` (`tiny` through `large-v3`),
`WHISPER_DEVICE` (`cuda`/`cpu`), and `WHISPER_COMPUTE_TYPE` to override
the defaults. First run of any model downloads it.

It also runs with `vad_filter=True`, which skips silence and
background noise instead of transcribing (or hallucinating words from)
it — this matters much more for real call audio than for a clean test
clip, since a live room or call has a lot more dead air and noise in
each 5-second segment than a scripted sentence does.

This was tested end to end while building it — real synthesized speech
sent through the full path (browser call → `server.js` proxy →
`transcribe_server.py`) came back correctly transcribed, on both GPU
and CPU. What's still unverified is the browser capture step itself
(`getDisplayMedia` + `MediaRecorder` against a real Meet/Teams/Zoom
tab) — the HTTP/transcription pipeline behind it is confirmed working,
but try the actual "Capture call audio" button against a live call
before relying on it.

### Claude Code bridge (subscription mode)

To use the "Claude Code (VS Code subscription)" provider option:

1. Install the Claude Code CLI and log in once: `claude login`.
2. Run `node server.js`. It generates (or reads from `.env`) a bridge
   token and the page picks it up automatically via the config prefill
   — no copy/pasting required.
3. In the page, select "Claude Code (VS Code subscription)" as the
   provider.

The bridge keeps one Claude Code CLI process alive for the life of the
`server.js` run — not a fresh subprocess per question — using the CLI's
streaming JSON headless mode. That part of `server.js` was written
against the documented protocol but wasn't tested against a live
`claude` binary while building it, so treat that path as the thing to
verify first; if your installed CLI version's event output differs
from what's expected, the fix is contained to `_onStdout` in
`server.js`.

The bridge route only accepts requests carrying its token and only
listens on `127.0.0.1` — never reachable from another device on your
network.

## Known constraints

- **LM Studio + Claude.ai artifact preview** — local model calls do not
  work inside the Claude.ai artifact preview, because its sandboxed
  iframe only allows requests to `api.anthropic.com`.
- **Secrets belong in `.env`, not the HTML** — real tokens/keys should
  only ever go in your gitignored `.env` (or be typed into the page at
  runtime). Never put one back into `mock-interview-copilot.html`
  directly — that file is version-controlled.
- **Local model and Claude Code both need `server.js`** — only the
  Claude (cloud API) provider works with a plain opened HTML file;
  Local model needs the proxy in `server.js`, and Claude Code needs
  both `server.js` and the CLI installed and logged in.
- **Claude Code streaming path is unverified** — the persistent-session
  bridge in `server.js` was built against the CLI's documented
  streaming JSON protocol but not run against a live `claude` binary.
  Test it before relying on it; see the Configuration section above.
- **Call audio capture needs `transcribe_server.py` running** — install
  once (`pip install -r requirements-transcribe.txt`) and run it
  alongside `node server.js`. The transcription pipeline itself is
  verified end to end (tested with real synthesized speech); the
  browser-side capture step against an actual live call is not — try
  it once before relying on it.
- **Call audio capture only sees browser-tab audio** — it captures via
  `getDisplayMedia`, which needs the call running in a browser tab with
  "share tab audio" enabled. A desktop app (e.g. the Teams desktop
  client, not Teams-in-browser) isn't a capturable tab, so this won't
  pick it up.
- **No persistence** — all state (transcript, code, log, debrief) lives
  in memory and is lost on refresh or tab close.
- **No auth, no multi-user support** — this is a personal/single-user
  local tool, not a hosted product; no saved history across sessions
  or across students.
- **Speech-to-text browser support** — live transcription requires a
  Chromium-based browser (Chrome or Edge).

## Design tokens

Dark "whiteboard" theme:

| Token | Value |
|---|---|
| Background | `#1B1F23` |
| Panel | `#21262C` / `#262C33` |
| Border | `#343B42` |
| Text | `#E8E6E1` (dim: `#9AA3AC`) |
| Accent (amber) | `#E8A33D` |
| Good (green) | `#6FBF73` |
| Bad (red) | `#E2685A` |

Fonts: Space Grotesk (UI text), JetBrains Mono (code, transcript, timer),
loaded via Google Fonts.

## Natural next steps

These have been discussed but not built:

- A difficulty/topic picker that generates a fresh practice problem.
- A rubric matching a specific school interview club's format.
- A "quiet transcript" nudge — a chime or prompt if no speech is
  detected for N seconds, to catch silent thinking.
- Persistence across sessions (saved debriefs and rubrics per student).