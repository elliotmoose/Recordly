#!/usr/bin/env node
/**
 * Drive the real Recordly Electron app headlessly (Xvfb + software GL) over
 * the Chrome DevTools Protocol. Built for cloud containers; see CLAUDE.md.
 *
 * Run as the unprivileged user created by scripts/cloud/setup.sh, under Xvfb:
 *
 *   sudo -u tester env "PATH=$PATH" xvfb-run -a -s '-screen 0 1600x1000x24' \
 *     node scripts/cloud/electron-e2e.cjs export --project demo.recordly --out out.mp4
 *
 *   sudo -u tester env "PATH=$PATH" xvfb-run -a -s '-screen 0 1600x1000x24' \
 *     node scripts/cloud/electron-e2e.cjs steps --input clip.mp4 --steps my-steps.cjs
 *
 * Modes:
 *   export  Use the app's built-in smoke export: open --project (or --input)
 *           in the editor, export to --out, quit. The app writes
 *           <out>.report.json with success/phase/timings.
 *   steps   Open the editor on --input, then run --steps: a CommonJS module
 *           exporting `async (page, ctx) => {}` where page is a Playwright
 *           Page for the editor window and ctx = { sleep, workDir, shot,
 *           projectsDir }. --project files are copied into the app's projects
 *           directory first so steps can open them from the project browser.
 *
 * Options:
 *   --input <video>     Recording to open (steps mode requires it).
 *   --project <file>    .recordly project (repeatable in steps mode).
 *   --out <file>        Export output (export mode). Default: <workDir>/out.mp4
 *   --steps <module>    Steps module (steps mode).
 *   --work-dir <dir>    Screenshots etc. Default: current directory.
 *   --timeout <ms>      Kill the app after this long. Default: 180000.
 *   --screenshots       Export mode: screenshot every 500ms (shot-NNN.png).
 *   --webgpu            Keep navigator.gpu. By default it is hidden, because
 *                       WebGPU on SwiftShader crashes; rendering uses WebGL.
 *   --port <n>          DevTools port. Default: 9333.
 */
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../..");
const ELECTRON = path.join(REPO_ROOT, "node_modules/electron/dist/electron");
// No GPU in the container: software GL via ANGLE/SwiftShader.
const GL_FLAGS = [
	"--use-gl=angle",
	"--use-angle=swiftshader",
	"--enable-unsafe-swiftshader",
	"--ignore-gpu-blocklist",
];
const NOISE = /dbus|ALSA|alsa|gl_factory|viz_main|Fontconfig/;

function parseArgs(argv) {
	const [mode, ...rest] = argv;
	const opts = { mode, projects: [], timeout: 180000, port: 9333, workDir: process.cwd() };
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		const value = () => rest[++i];
		if (arg === "--input") opts.input = path.resolve(value());
		else if (arg === "--project") opts.projects.push(path.resolve(value()));
		else if (arg === "--out") opts.out = path.resolve(value());
		else if (arg === "--steps") opts.steps = path.resolve(value());
		else if (arg === "--work-dir") opts.workDir = path.resolve(value());
		else if (arg === "--timeout") opts.timeout = Number(value());
		else if (arg === "--port") opts.port = Number(value());
		else if (arg === "--screenshots") opts.screenshots = true;
		else if (arg === "--webgpu") opts.webgpu = true;
		else throw new Error(`Unknown option ${arg}`);
	}
	return opts;
}

function loadPlaywright() {
	// Not a repo dependency; the cloud image ships it globally.
	for (const candidate of [
		process.env.PLAYWRIGHT_PATH,
		"playwright",
		"playwright-core",
		path.join(execSync("npm root -g").toString().trim(), "playwright"),
	].filter(Boolean)) {
		try {
			return require(candidate);
		} catch {
			// try the next candidate
		}
	}
	throw new Error("playwright not found; npm install -g playwright (no browser download needed)");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectToEditor(chromium, port) {
	let browser;
	for (let i = 0; i < 120 && !browser; i++) {
		try {
			browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
		} catch {
			await sleep(250);
		}
	}
	if (!browser) throw new Error("Could not connect to Electron over CDP");
	for (let i = 0; i < 120; i++) {
		const page = browser
			.contexts()
			.flatMap((context) => context.pages())
			.find((candidate) => candidate.url().includes("windowType=editor"));
		if (page) return page;
		await sleep(250);
	}
	throw new Error("Editor window never opened");
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (!["export", "steps"].includes(opts.mode)) {
		const header = fs.readFileSync(__filename, "utf8").split("*/")[0];
		console.log(header.replace(/^#!.*\n\/\*\*\n?/, "").replace(/^ \* ?/gm, ""));
		process.exit(opts.mode === "--help" || !opts.mode ? 0 : 1);
	}
	if (process.getuid && process.getuid() === 0) {
		throw new Error(
			"Run as a non-root user (see scripts/cloud/setup.sh); root breaks the preload",
		);
	}
	fs.mkdirSync(opts.workDir, { recursive: true });

	const env = { ...process.env };
	if (opts.mode === "export") {
		if (!opts.input && !opts.projects[0]) throw new Error("export needs --input or --project");
		opts.out ??= path.join(opts.workDir, "out.mp4");
		Object.assign(env, {
			RECORDLY_SMOKE_EXPORT: "1",
			RECORDLY_SMOKE_EXPORT_OUTPUT: opts.out,
			...(opts.input && { RECORDLY_SMOKE_EXPORT_INPUT: opts.input }),
			...(opts.projects[0] && { RECORDLY_SMOKE_EXPORT_PROJECT: opts.projects[0] }),
			...(!opts.webgpu && { RECORDLY_SMOKE_EXPORT_RENDER_BACKEND: "webgl" }),
		});
	} else {
		if (!opts.input || !opts.steps) throw new Error("steps needs --input and --steps");
		env.RECORDLY_DEV_OPEN_RECORDING_INPUT = opts.input;
	}

	const { chromium } = loadPlaywright();
	const child = spawn(
		ELECTRON,
		[REPO_ROOT, `--remote-debugging-port=${opts.port}`, ...GL_FLAGS],
		{
			cwd: REPO_ROOT,
			env,
		},
	);
	let mainLog = "";
	child.stdout.on("data", (chunk) => {
		mainLog += chunk;
	});
	child.stderr.on("data", (chunk) => {
		mainLog += chunk;
	});
	const exited = new Promise((resolve) => child.on("exit", resolve));
	const finish = (code) => {
		child.kill("SIGKILL");
		const tail = mainLog
			.split("\n")
			.filter((line) => line && !NOISE.test(line))
			.slice(-15)
			.join("\n");
		console.log(`--- main process log (tail) ---\n${tail}`);
		process.exit(code);
	};
	const deadline = setTimeout(() => {
		console.log(`[e2e] timed out after ${opts.timeout}ms`);
		finish(1);
	}, opts.timeout);

	const page = await connectToEditor(chromium, opts.port);
	page.on("pageerror", (error) => console.log("[pageerror]", error.message));
	if (!opts.webgpu) {
		await page.context().addInitScript(() =>
			Object.defineProperty(Navigator.prototype, "gpu", {
				get: () => undefined,
				configurable: true,
			}),
		);
		await page.reload();
	}

	if (opts.mode === "export") {
		let n = 0;
		const timer =
			opts.screenshots &&
			setInterval(() => {
				const file = path.join(opts.workDir, `shot-${String(n++).padStart(3, "0")}.png`);
				page.screenshot({ path: file }).catch(() => undefined);
			}, 500);
		await exited;
		if (timer) clearInterval(timer);
		clearTimeout(deadline);
		const reportPath = `${opts.out}.report.json`;
		const report = fs.existsSync(reportPath)
			? JSON.parse(fs.readFileSync(reportPath, "utf8"))
			: null;
		console.log(
			`[e2e] export ${report?.success ? "succeeded" : "FAILED"}: phase=${report?.phase} elapsedMs=${report?.elapsedMs} -> ${opts.out}`,
		);
		if (!report?.success && report?.error) console.log(`[e2e] error: ${report.error}`);
		finish(report?.success ? 0 : 1);
		return;
	}

	await sleep(3000);
	const dirResult = await page.evaluate(() => window.electronAPI.getProjectsDirectory());
	const projectsDir =
		typeof dirResult === "string" ? dirResult : (dirResult?.path ?? dirResult?.directory);
	if (projectsDir) {
		fs.mkdirSync(projectsDir, { recursive: true });
		for (const project of opts.projects) {
			fs.copyFileSync(project, path.join(projectsDir, path.basename(project)));
		}
	}
	const shot = (name) => page.screenshot({ path: path.join(opts.workDir, `${name}.png`) });
	let code = 0;
	try {
		await require(opts.steps)(page, { sleep, workDir: opts.workDir, shot, projectsDir });
	} catch (error) {
		code = 1;
		console.log("[e2e] steps failed:", error.stack ?? error);
		await shot("steps-error").catch(() => undefined);
	}
	clearTimeout(deadline);
	finish(code);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
