# whisplay-ai-chatbot (Eric's Fork)

## Versioning

Every change to device code bumps `VERSION` in `python/chatbot-ui.py` (displayed bottom-right on the LCD):
- **Patch** (0.1.x): bug fixes, tweaks
- **Minor** (0.x.0): new features
- Bump the version in the same commit as the change.

## Deploy Workflow

```bash
# 1. Edit locally, test, commit, push
git push origin master

# 2. On Pi (via SSH to pi@192.168.1.15)
cd /home/pi/whisplay-ai-chatbot
git pull origin master
# Only if TypeScript changed:
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"
NODE_OPTIONS="--max-old-space-size=200" npm run build
# Always:
sudo systemctl restart chatbot
```

## Pi Zero Constraints

- **416MB RAM total** — Node.js + Python use ~220-260MB
- `NODE_OPTIONS=--max-old-space-size=200` required for builds and in systemd service
- `npm install --no-optional` required (yarn and regular npm OOM)
- numpy must be <2 (1.26.4) for Pillow compatibility
- Python takes 30-60s to start (connection retries are normal)

## Architecture

- **Node.js** (`src/`): state machine, ASR/LLM/TTS plugins, socket client
- **Python** (`python/chatbot-ui.py`): LCD rendering, button GPIO, socket server on port 12345
- Button events flow: hardware → Python → TCP JSON → Node.js state machine
- Display updates flow: Node.js → TCP JSON → Python → SPI → LCD

## Custom Changes from Upstream

Keep changes minimal and upstream-compatible. Current diffs:
- `src/device/audio.ts` — SIGKILL fallback for sox process kill
- `src/core/chat-flow/states.ts` — .catch() on ASR Promise.race
- `python/chatbot-ui.py` — VERSION overlay
