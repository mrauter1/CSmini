import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKER_ROOT = path.join(ROOT, "workers/signaling");
const LOCAL_SIGNALING_URL = "http://127.0.0.1:8787";

function tailLines(lines) {
  return lines.length > 0 ? lines.join("\n") : "(no output)";
}

function startBufferedProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  const stdout = [];
  const stderr = [];
  const pushLine = (lines, chunk) => {
    const text = chunk.toString("utf8").trim();
    if (!text) {
      return;
    }
    lines.push(text);
    if (lines.length > 60) {
      lines.shift();
    }
  };

  child.stdout?.on("data", (chunk) => pushLine(stdout, chunk));
  child.stderr?.on("data", (chunk) => pushLine(stderr, chunk));

  return { child, stdout, stderr };
}

async function stopProcess(record) {
  const child = record?.child;
  if (!child?.pid) {
    return;
  }

  const processGroupExists = () => {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") {
        return false;
      }
      throw error;
    }
  };

  const killTree = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  };

  if (!processGroupExists()) {
    await Promise.race([new Promise((resolve) => child.once("close", resolve)), delay(250)]);
    return;
  }

  const waitForExit = async (timeoutMs) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (!processGroupExists()) {
        return true;
      }
      await delay(100);
    }
    return !processGroupExists();
  };

  killTree("SIGTERM");
  if (await waitForExit(2_000)) {
    return;
  }

  killTree("SIGKILL");
  await waitForExit(2_000);
}

async function waitForHealth(url, record, timeoutMs = 25_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${url}/health`, { cache: "no-store" });
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the worker is ready or times out.
    }

    if (record.child.exitCode !== null) {
      break;
    }

    await delay(250);
  }

  throw new Error(
    [
      `Timed out waiting for local signaling worker at ${url}.`,
      `stdout:\n${tailLines(record.stdout)}`,
      `stderr:\n${tailLines(record.stderr)}`,
    ].join("\n\n"),
  );
}

async function runChildScript(scriptPath, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: ROOT,
      env,
      stdio: "inherit",
    });

    child.on("close", (code, signal) => {
      resolve({ code: code ?? 1, signal });
    });
  });
}

async function main() {
  const scriptArg = process.argv[2];
  if (!scriptArg) {
    throw new Error("Usage: node scripts/qa/runWithLocalSignalingWorker.mjs <script-path>");
  }

  const scriptPath = path.isAbsolute(scriptArg) ? scriptArg : path.join(ROOT, scriptArg);
  let workerRecord = null;
  let tempRoot = null;

  try {
    const childEnv = { ...process.env };

    if (!childEnv.SIGNALING_URL) {
      tempRoot = await mkdtemp(path.join(os.tmpdir(), "cs-webrtc-signaling-"));
      const wranglerHome = path.join(tempRoot, "wrangler-home");
      const wranglerConfig = path.join(tempRoot, "wrangler-config");
      const npmCache = path.join(tempRoot, "npm-cache");
      const persistDir = path.join(tempRoot, "wrangler-state");

      workerRecord = startBufferedProcess(
        "npx",
        [
          "--yes",
          "wrangler",
          "dev",
          "--local",
          "--port",
          "8787",
          "--persist-to",
          persistDir,
        ],
        {
          cwd: WORKER_ROOT,
          env: {
            ...process.env,
            HOME: wranglerHome,
            XDG_CONFIG_HOME: wranglerConfig,
            npm_config_cache: npmCache,
            CI: "1",
          },
        },
      );

      await waitForHealth(LOCAL_SIGNALING_URL, workerRecord);
      childEnv.SIGNALING_URL = LOCAL_SIGNALING_URL;
    }

    const result = await runChildScript(scriptPath, childEnv);
    process.exitCode = result.code;
  } finally {
    await stopProcess(workerRecord);
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
