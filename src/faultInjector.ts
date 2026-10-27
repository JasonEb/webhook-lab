export type FaultMode =
  | { type: "none" }
  | { type: "fail_first"; n: number }
  | { type: "slow"; ms: number }
  | { type: "status"; code: number; n: number };

export function parseFaultMode(raw: string | undefined): FaultMode {
  if (!raw || raw === "none") return { type: "none" };
  const [kind, ...rest] = raw.split(":");
  if (kind === "fail_first") {
    const n = Number(rest[0]);
    if (!Number.isFinite(n)) throw new Error(`Invalid FAULT_MODE: ${raw}`);
    return { type: "fail_first", n };
  }
  if (kind === "slow") {
    const ms = Number(rest[0]);
    if (!Number.isFinite(ms)) throw new Error(`Invalid FAULT_MODE: ${raw}`);
    return { type: "slow", ms };
  }
  if (kind === "status") {
    const code = Number(rest[0]);
    const n = Number(rest[1] ?? 1);
    if (!Number.isFinite(code) || !Number.isFinite(n)) throw new Error(`Invalid FAULT_MODE: ${raw}`);
    return { type: "status", code, n };
  }
  throw new Error(`Invalid FAULT_MODE: ${raw}`);
}

export interface FaultDecision {
  statusCode: number | null; // null = proceed normally; otherwise short-circuit with this code
  delayMs: number;
}

export function decideFault(mode: FaultMode, priorArrivalCount: number): FaultDecision {
  switch (mode.type) {
    case "fail_first":
      return { statusCode: priorArrivalCount < mode.n ? 500 : null, delayMs: 0 };
    case "status":
      return { statusCode: priorArrivalCount < mode.n ? mode.code : null, delayMs: 0 };
    case "slow":
      return { statusCode: null, delayMs: mode.ms };
    default:
      return { statusCode: null, delayMs: 0 };
  }
}

export function logFaultModeWarningIfActive(mode: FaultMode): void {
  if (mode.type === "none") return;
  console.warn("");
  console.warn("########################################################");
  console.warn("# FAULT INJECTION IS ACTIVE — THIS MUST NEVER RUN IN A  #");
  console.warn("# REAL DEPLOYMENT. FAULT_MODE =", JSON.stringify(mode));
  console.warn("########################################################");
  console.warn("");
}
