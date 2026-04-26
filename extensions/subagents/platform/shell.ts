export function getShellInvocation(command: string): { command: string; args: string[] } {
  return { command: "/bin/sh", args: ["-c", command] };
}
