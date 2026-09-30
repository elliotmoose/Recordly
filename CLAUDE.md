# Recordly: notes for coding agents

`AGENTS.md` is a symlink to this file. Keep one copy.

Recordly is an Electron + React + Vite screen recorder and editor. The renderer lives in `src/` and the main process plus IPC lives in `electron/`. Native helpers are in `electron/native/`. Captions come from a bundled whisper.cpp binary (`whisper-cli`) that runs on the user's machine, with no transcription API involved. For end-user build prerequisites, see "Build from source" in `README.md`.

## Checks to run before pushing

```bash
npx tsc --noEmit
npm run lint            # biome lint
npm run format:check    # biome format; fix with: npx biome format --write <files>
npx vitest --run        # unit tests
npm run i18n:check      # every locale in src/i18n/locales/* must have identical keys
```

- **Locales:** when you add a UI string, add the key to all 11 locale files.
- **Editing locale JSON:** insert lines textually. Re-serialising a locale file reflows it and creates a noisy diff.

## Running in a headless cloud container

Unit tests only need `npm install --ignore-scripts`. To build the app and drive the real Electron window (captions, preview playback, export), run once as root:

```bash
scripts/cloud/setup.sh
```

The script is idempotent. The network policy must allow `registry.npmjs.org`, `github.com`, `objects.githubusercontent.com` and `huggingface.co`.

What it does, and why:

| Step | Why |
|---|---|
| `apt install build-essential cmake xvfb libnss3-tools libx*-dev` | Toolchain for whisper.cpp and native modules, a virtual display, and NSS tools. |
| `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --ignore-scripts`, then `node node_modules/{electron,ffmpeg-static}/install.js` | `postinstall` tries to build every platform's native helpers, and several of those can't build here. This installs only what the app needs. |
| `npm run build:whisper-runtime` | Compiles whisper.cpp into `electron/native/bin/linux-x64/`. |
| Creates user `tester` | As root, Electron needs `--no-sandbox`, which makes the preload load as ESM and leaves `window.electronAPI` undefined. Always run the app as a normal user. |
| curls `ggml-small.bin` into `~tester/.config/Recordly/whisper/` | The in-app model download uses Node `https`, which ignores the egress proxy. |
| Imports `/root/.ccr/ca-bundle.crt` into `~tester/.pki/nssdb` | Chromium's `net.fetch` (used by the Auto-cut AI assist) trusts the NSS db, not the system bundle. Without it you get `ERR_CERT_AUTHORITY_INVALID`. |
| `npx vite build` and `npm run normalize:electron-main-cjs` | Produces `dist/` and `dist-electron/`, which is what `electron .` loads. Re-run after every source change you want to exercise in the app. |

### Driving the app

`scripts/cloud/electron-e2e.cjs` launches Electron under software GL and attaches Playwright over CDP. It uses the globally installed `playwright` package, with no browser download. Pass `PATH` through `sudo` so the right Node and the global modules resolve:

```bash
# Export a project or recording through the app's real export pipeline.
# It writes out.mp4 plus out.mp4.report.json.
sudo -u tester env "PATH=$PATH" xvfb-run -a -s '-screen 0 1600x1000x24' \
  node scripts/cloud/electron-e2e.cjs export --project /path/demo.recordly --out /path/out.mp4

# Open the editor on a recording and run scripted UI steps.
sudo -u tester env "PATH=$PATH" xvfb-run -a -s '-screen 0 1600x1000x24' \
  node scripts/cloud/electron-e2e.cjs steps --input /path/clip.mp4 --steps /path/steps.cjs \
  --project /path/demo.recordly --work-dir /path/out
```

The steps module looks like this:

```js
module.exports = async (page, { sleep, shot, workDir, projectsDir }) => {
	await sleep(3000); // let the editor load
	await page.getByText("my-project", { exact: true }).click();
	await shot("after-click"); // writes <workDir>/after-click.png
};
```

Screenshots are the main way to check UI state. Read the PNGs back to look at them.

- **Files the app can read:** put inputs somewhere the `tester` user can read, such as `/home/tester/...`.
- **Files the app writes:** it writes projects and settings under `~tester/.config/Recordly/`. Projects live in `recordings/Projects/`.
- **Opening a project in steps mode:** `--project` copies the file into the projects directory. Open it from the project browser: the header's first button, then click the project's name.

Environment the driver sets, which you can also set yourself:

| Variable | Effect |
|---|---|
| `RECORDLY_DEV_OPEN_RECORDING_INPUT=<video>` | Opens the editor straight onto a recording and skips the launch/HUD windows. |
| `RECORDLY_SMOKE_EXPORT=1` with `RECORDLY_SMOKE_EXPORT_{PROJECT,INPUT,OUTPUT}` | Headless export, then quit. More knobs (`_FPS`, `_QUALITY`, `_USE_NATIVE`, ...) are listed in `electron/windows.ts`. |
| `RECORDLY_SMOKE_EXPORT_RENDER_BACKEND=webgl` | Renders the export with WebGL. |
| Chromium flags `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist` | Software GL, because the container has no GPU. |

The driver also hides `navigator.gpu`, because WebGPU on SwiftShader crashes the renderer. Pass `--webgpu` to keep it.

### Using whisper and ffmpeg directly

You can use the bundled binaries on their own, for fixtures or benchmarks:

```bash
ffmpeg=node_modules/ffmpeg-static/ffmpeg
whisper=electron/native/bin/linux-x64/whisper-cli
$ffmpeg -i clip.mp4 -ar 16000 -ac 1 clip.wav
$whisper -m ~tester/.config/Recordly/whisper/ggml-small.bin -f clip.wav -l en -ojf -dtw small -nfa -t 4
```

This is the same invocation the app uses (see `electron/ipc/captions/generate.ts`).

### LLM keys for testing

The Auto-cut AI assist accepts any OpenAI-compatible endpoint. Provide keys only through environment variables or the in-app settings, which keep them in `safeStorage`.

**Never commit a key**, and never write one into a fixture, a test or a log.

### Known quirks here

- **Opening a project whose video is already open:** the timeline comes up empty. Start the driver with a different `--input` video, then open the project.
- **Export speed:** software rendering exports at about 3 fps, so give long exports a generous `--timeout`.
- **Transcription speed:** it competes with the renderer for CPU. The app uses `floor(cores/2)` whisper threads, clamped to 1–8.
- **Log noise:** these messages are harmless:
  - `SELF_SIGNED_CERT_IN_CHAIN` from the main process, which comes from a Node `https` request that doesn't trust the proxy CA. Set `NODE_EXTRA_CA_CERTS` if it matters.
  - `Blocked disallowed path ... .mic.wav`.
  - dbus and ALSA warnings.

## Editing model: quick reference

- **Clips (`ClipRegion`):** `startMs`/`endMs` are timeline positions. `sourceStartMs` is where the clip starts in the recording, and defaults to `startMs`. No two clips show the same source time.
- **Source-time data:** captions, cursor telemetry and speed regions.
- **Timeline-time data:** zoom, annotation and audio regions.
- **Converting between them:** use the helpers in `src/components/video-editor/types.ts` (`getPlaybackSegments`, `mapTimelineRangeToSourceRanges`, `mapTimelineRegionsToSource`).
- **Moving, trimming and packing clips:** use `src/components/video-editor/timelineRipple.ts`.
