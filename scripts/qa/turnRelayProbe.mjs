import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const SIGNALING_URL = process.env.SIGNALING_URL ?? "https://csmini-signaling.csmini.workers.dev";
const DEBUG_PORT = process.env.DEBUG_PORT ?? "9236";
const DEBUG_ORIGIN = `http://127.0.0.1:${DEBUG_PORT}`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function startProcess(command, args) {
  const child = spawn(command, args, {
    detached: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = [];
  const stderr = [];
  const pushLine = (lines, chunk) => {
    const text = chunk.toString("utf8").trim();
    if (!text) {
      return;
    }
    lines.push(text);
    if (lines.length > 40) {
      lines.shift();
    }
  };

  child.stdout?.on("data", (chunk) => pushLine(stdout, chunk));
  child.stderr?.on("data", (chunk) => pushLine(stderr, chunk));
  return { child, stdout, stderr };
}

async function stopProcess(record) {
  if (!record?.child?.pid) {
    return;
  }

  try {
    process.kill(-record.child.pid, "SIGTERM");
  } catch {
    return;
  }

  await Promise.race([
    new Promise((resolve) => record.child.once("close", resolve)),
    delay(2_000),
  ]);

  try {
    process.kill(-record.child.pid, "SIGKILL");
  } catch {
    // The process already exited.
  }
}

async function waitForHttp(url, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling.
    }
    await delay(200);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function requestJsonNew(url) {
  for (const method of ["PUT", "GET"]) {
    try {
      const response = await fetch(`${DEBUG_ORIGIN}/json/new?${encodeURIComponent(url)}`, {
        method,
      });
      if (response.ok) {
        return response.json();
      }
    } catch {
      // Try the next method.
    }
  }

  throw new Error(`Could not create a Chrome target for ${url}`);
}

class CdpPage {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = new WebSocket(webSocketUrl);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        return;
      }
      const callbacks = this.pending.get(message.id);
      if (!callbacks) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        callbacks.reject(new Error(message.error.message));
      } else {
        callbacks.resolve(message.result);
      }
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId;
    this.nextId += 1;
    const result = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "Evaluation failed.");
    }
    return result.result.value;
  }

  async close() {
    try {
      await this.send("Page.close");
    } catch {
      // Ignore close failures in cleanup.
    }
    this.socket.close();
  }
}

async function fetchIceServers() {
  const url = new URL(SIGNALING_URL);
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}/turn-credentials`;
  url.search = "";
  url.hash = "";

  const response = await fetch(url, { cache: "no-store" });
  assert(response.ok, `TURN credential endpoint failed with HTTP ${response.status}`);
  const iceServers = await response.json();
  assert(Array.isArray(iceServers), "TURN credential endpoint did not return an ICE server array.");

  const urls = iceServers.flatMap((server) => (Array.isArray(server.urls) ? server.urls : [server.urls]));
  assert(urls.some((value) => typeof value === "string" && /^turns?:/.test(value)), "No TURN URLs were returned.");
  return iceServers;
}

async function startChrome() {
  const chrome = startProcess("google-chrome", [
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=/tmp/csmini-turn-relay-${Date.now()}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ]);
  await waitForHttp(`${DEBUG_ORIGIN}/json/version`);
  return chrome;
}

async function main() {
  const iceServers = await fetchIceServers();
  let chrome;
  let page;

  try {
    chrome = await startChrome();
    const target = await requestJsonNew("about:blank");
    page = new CdpPage(target.webSocketDebuggerUrl);
    await page.send("Page.enable");

    const result = await page.evaluate(`
      (async () => {
        const iceServers = ${JSON.stringify(iceServers)};
        const left = new RTCPeerConnection({ iceServers, iceTransportPolicy: "relay" });
        const right = new RTCPeerConnection({ iceServers, iceTransportPolicy: "relay" });
        const waitUntil = (predicate, timeoutMs = 30000) => new Promise((resolve, reject) => {
          const startedAt = Date.now();
          const tick = () => {
            try {
              const value = predicate();
              if (value) {
                resolve(value);
                return;
              }
            } catch (error) {
              reject(error);
              return;
            }
            if (Date.now() - startedAt >= timeoutMs) {
              reject(new Error("Timed out waiting for relay-only WebRTC connection."));
              return;
            }
            setTimeout(tick, 50);
          };
          tick();
        });

        const received = new Promise((resolve) => {
          right.addEventListener("datachannel", (event) => {
            event.channel.addEventListener("message", (message) => {
              resolve(String(message.data));
            });
          });
        });

        left.addEventListener("icecandidate", (event) => {
          if (event.candidate) {
            void right.addIceCandidate(event.candidate);
          }
        });
        right.addEventListener("icecandidate", (event) => {
          if (event.candidate) {
            void left.addIceCandidate(event.candidate);
          }
        });

        const channel = left.createDataChannel("relay-probe");
        const open = new Promise((resolve) => {
          channel.addEventListener("open", resolve, { once: true });
        });

        const offer = await left.createOffer();
        await left.setLocalDescription(offer);
        await right.setRemoteDescription(offer);
        const answer = await right.createAnswer();
        await right.setLocalDescription(answer);
        await left.setRemoteDescription(answer);

        await open;
        channel.send("relay-ok");
        const message = await received;
        await waitUntil(() => left.connectionState === "connected" && right.connectionState === "connected");

        const stats = await left.getStats();
        let selectedPair = null;
        for (const report of stats.values()) {
          if (report.type === "transport" && report.selectedCandidatePairId) {
            selectedPair = stats.get(report.selectedCandidatePairId);
            break;
          }
          if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) {
            selectedPair = report;
          }
        }

        const localCandidate = selectedPair ? stats.get(selectedPair.localCandidateId) : null;
        const remoteCandidate = selectedPair ? stats.get(selectedPair.remoteCandidateId) : null;
        const summary = {
          message,
          leftState: left.connectionState,
          rightState: right.connectionState,
          localCandidateType: localCandidate?.candidateType ?? null,
          remoteCandidateType: remoteCandidate?.candidateType ?? null,
          localProtocol: localCandidate?.protocol ?? null,
          remoteProtocol: remoteCandidate?.protocol ?? null,
        };

        left.close();
        right.close();
        return summary;
      })()
    `);

    assert(result.message === "relay-ok", "Relay-only DataChannel did not echo the probe message.");
    assert(result.localCandidateType === "relay", "Selected local candidate was not a TURN relay candidate.");

    console.log(JSON.stringify({ signalingUrl: SIGNALING_URL, ...result }, null, 2));
  } finally {
    await page?.close();
    await stopProcess(chrome);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
