import { execFile } from "node:child_process";

export type NotificationRunner = (executable: string, args: readonly string[]) => Promise<void>;

const defaultRunner: NotificationRunner = async (executable, args) =>
  new Promise<void>((resolve, reject) => {
    execFile(executable, [...args], (error) => (error ? reject(error) : resolve()));
  });

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replace(/[\r\n]+/g, " ").slice(0, 240)}"`;
}

export async function notifyEscalation(
  title: string,
  message: string,
  options: { platform?: NodeJS.Platform; runner?: NotificationRunner } = {},
): Promise<boolean> {
  if ((options.platform ?? process.platform) !== "darwin") return false;
  const script = `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`;
  await (options.runner ?? defaultRunner)("osascript", ["-e", script]);
  return true;
}
