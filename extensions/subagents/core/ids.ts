import { randomBytes } from "node:crypto";

export function createJobId(now = Date.now()): string {
  return `agent_${now.toString(36)}_${randomBytes(4).toString("hex")}`;
}

export function tmuxSessionName(id: string): string {
  return `pi-${id}`.replace(/[^A-Za-z0-9_.:-]/g, "-");
}

export function shortJobId(id: string): string {
  const match = /^agent_[^_]+_([a-f0-9]+)$/i.exec(id);
  return match?.[1]?.slice(0, 8) ?? id.slice(-8);
}
