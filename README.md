# Mock Interview Copilot

A practice tool for school mock coding interviews. Two real people — a
student and a peer or coach — sit at one screen together. The tool gives
live coaching insights and correctness/complexity feedback during the
practice attempt, then a structured debrief afterward.

## What it is

A single self-contained HTML file: [mock-interview-copilot.html](mock-interview-copilot.html).
Vanilla JavaScript, no build step, no framework, no backend.

## Features

- **Problem / code / language panes** — plain textareas plus a language
  selector for the candidate's working language.
- **Live transcription** — uses the browser's `SpeechRecognition` /
  `webkitSpeechRecognition` API (Chrome/Edge only). Auto-restarts while
  toggled on. Shows interim and final results as they arrive.
- **Session timer** — start/pause.
- **Coach panel** — four tabbed modes, each sending a distinct prompt to
  the model:
  - **Hint** — a nudge, never the full answer.
  - **Correctness** — checks the code against the stated problem.
  - **Complexity** — reports time/space Big-O and a possible improvement.
  - **Reveal** — the full approach, meant for after a real attempt or
    during review.
- **Live coaching strip** — an opt-in toggle (off by default). Watches
  code and transcript changes, waits for a 2.5s idle pause, and
  rate-limits itself to one call per 12 seconds. Produces a glanceable
  nudge of 15 words or fewer. Never gives a full solution.
- **End-of-session debrief** — a structured scorecard (approach,
  correctness, communication, one strength, one improvement, suggested
  next problem type) built from the full session context.
- **Session log** — a running list of every coach and live-coaching
  request, with a truncated response for each.
- **Model provider switch** — choose "Claude (cloud)" or "Local (LM
  Studio)". Local mode posts OpenAI-chat-completions-format requests to
  a configurable URL (default `http://localhost:1234/v1/chat/completions`)
  with an optional model name field.

## Running it

Open the file directly in a browser, or serve it locally:

```bash
python3 -m http.server
```

Then visit `http://localhost:8000/mock-interview-copilot.html`.

Serving over HTTP is more reliable than opening the file directly
(`file://`) when using local model mode, because of CORS.

## Known constraints

- **LM Studio + Claude.ai artifact preview** — local model calls do not
  work inside the Claude.ai artifact preview, because its sandboxed
  iframe only allows requests to `api.anthropic.com`. Local mode only
  works once the file runs standalone in a real browser.
- **LM Studio CORS** — the LM Studio server must have CORS enabled in
  its settings for local mode to reach it.
- **No persistence** — all state (transcript, code, log, debrief) lives
  in memory and is lost on refresh or tab close.
- **Single file, no backend** — no auth, no multi-user support, no
  saved history across sessions.
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