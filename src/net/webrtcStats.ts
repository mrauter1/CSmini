import type { RoomTransportPeerStats } from "./transport";

export async function samplePeerConnectionStats(
  connection: RTCPeerConnection,
  peerId: string,
  phase: string,
): Promise<RoomTransportPeerStats | null> {
  let report: RTCStatsReport;
  try {
    report = await connection.getStats();
  } catch {
    return null;
  }

  const pair = selectedCandidatePair(report);
  if (!pair) {
    return null;
  }

  const local = statsRecord(report.get(asString(pair.localCandidateId)));
  const remote = statsRecord(report.get(asString(pair.remoteCandidateId)));
  const localCandidateType = asString(local?.candidateType);
  const remoteCandidateType = asString(remote?.candidateType);

  return {
    peerId,
    phase,
    sampledAt: Date.now(),
    bytesSent: asNumber(pair.bytesSent),
    bytesReceived: asNumber(pair.bytesReceived),
    localCandidateType,
    remoteCandidateType,
    localProtocol: asString(local?.protocol),
    remoteProtocol: asString(remote?.protocol),
    usingRelay: localCandidateType === "relay" || remoteCandidateType === "relay",
  };
}

function selectedCandidatePair(report: RTCStatsReport): Record<string, unknown> | null {
  let selectedPairId = "";
  report.forEach((entry) => {
    const stats = statsRecord(entry);
    if (stats?.type === "transport" && typeof stats.selectedCandidatePairId === "string") {
      selectedPairId = stats.selectedCandidatePairId;
    }
  });

  const selected = statsRecord(report.get(selectedPairId));
  if (selected?.type === "candidate-pair") {
    return selected;
  }

  let bestPair: Record<string, unknown> | null = null;
  let bestBytes = -1;
  report.forEach((entry) => {
    const stats = statsRecord(entry);
    if (stats?.type !== "candidate-pair") {
      return;
    }

    const selectedLike =
      stats.selected === true ||
      (stats.nominated === true && stats.state === "succeeded") ||
      stats.state === "succeeded";
    if (!selectedLike) {
      return;
    }

    const bytes = asNumber(stats.bytesSent) + asNumber(stats.bytesReceived);
    if (bytes > bestBytes) {
      bestBytes = bytes;
      bestPair = stats;
    }
  });

  return bestPair;
}

function statsRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
