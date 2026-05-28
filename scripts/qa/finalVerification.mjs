import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const STEPS = [
  {
    id: "local-flow",
    script: "scripts/qa/localFlowVerification.mjs",
    description: "Menu -> roster -> solo arena smoke path",
  },
  {
    id: "manual-signaling",
    script: "scripts/qa/manualSignalingVerification.mjs",
    description: "Manual offer/answer signaling and WebRTC connection",
  },
  {
    id: "host-room",
    script: "scripts/qa/hostRoomStateVerification.mjs",
    description: "Host-authoritative input, snapshots, and disconnect cleanup",
  },
  {
    id: "shot-validation",
    script: "scripts/qa/shotValidationVerification.mjs",
    description: "Host-authoritative shot acceptance and rejection checks",
  },
];

function parseJson(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

async function runStep(step) {
  const startedAt = Date.now();
  const scriptPath = path.join(ROOT, step.script);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      const durationMs = Date.now() - startedAt;
      if (code !== 0) {
        reject(
          new Error(
            [
              `QA step failed: ${step.id}`,
              `script: ${step.script}`,
              `code: ${code ?? "null"}`,
              `signal: ${signal ?? "none"}`,
              stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
              stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
          ),
        );
        return;
      }

      resolve({
        id: step.id,
        description: step.description,
        durationMs,
        summary: parseJson(stdout),
      });
    });
  });
}

async function main() {
  const results = [];

  for (const step of STEPS) {
    results.push(await runStep(step));
  }

  console.log(
    JSON.stringify(
      {
        suite: "dustline-multiplayer-final",
        steps: results,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
