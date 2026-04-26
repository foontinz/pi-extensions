export interface SequencedLogEntry {
  seq: number;
}

export interface LogWindow<TLog extends SequencedLogEntry> {
  logs: TLog[];
  logWindowStartSeq?: number;
  logWindowEndSeq?: number;
  logsTruncated: boolean;
  cursorExpired: boolean;
}

export function getLogsSince<TLog extends SequencedLogEntry>(logs: TLog[], sinceSeq: number, maxLogEntries: number): TLog[] {
  return getLogWindow(logs, sinceSeq, maxLogEntries).logs;
}

export function getLogWindow<TLog extends SequencedLogEntry>(logs: TLog[], sinceSeq: number, maxLogEntries: number): LogWindow<TLog> {
  const retainedLogs = [...logs].sort((a, b) => a.seq - b.seq);
  const logWindowStartSeq = retainedLogs[0]?.seq;
  const logWindowEndSeq = retainedLogs[retainedLogs.length - 1]?.seq;
  const availableLogs = retainedLogs.filter((entry) => entry.seq > sinceSeq);
  return {
    logs: availableLogs.slice(0, maxLogEntries),
    logWindowStartSeq,
    logWindowEndSeq,
    logsTruncated: availableLogs.length > maxLogEntries,
    cursorExpired: logWindowStartSeq !== undefined && logWindowStartSeq > 1 && sinceSeq < logWindowStartSeq - 1,
  };
}
