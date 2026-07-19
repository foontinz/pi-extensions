# enhanced-bash

Overrides Pi's `bash` tool with non-interactive foreground defaults and
Claude-style event-driven background execution.

## Background Bash

Use `background:true` when process completion is the event, such as for a long
build, migration, or server. The call returns immediately with a task ID, PID,
and capped log path. Completion is injected into the session and wakes the
agent, so it does not need to sleep or poll.

## Monitor

The `monitor` tool watches a command without pausing the conversation. Each
non-empty stdout line is a meaningful event delivered back to the agent. Stderr
is retained in the log but does not trigger an event.

Monitor commands should print only state changes or actionable matches—not each
poll attempt. Events are UTF-8 framed, line-bounded, batched, rate-limited, and
coalesced while a previous wake is still being handled. Suppressed burst output
is reported and remains available in the task log.

A monitor ends after 30 minutes by default. Set `persistent:true` to run until
`stop_background_task` is called or the Pi session ends. `/background-tasks`
shows tasks in the UI.

Both background Bash and Monitor are rejected in Pi print (`-p`) and JSON modes.
Those modes exit after the turn, and a background process that inherits a pipe
could keep the Pi process alive.

## Home-deletion guard

Foreground Bash, background Bash, monitors, and user `!` commands prepend a
private `rm` shim to `PATH`. The shim validates `rm`'s final shell-expanded
arguments against the operating-system account home (not `$HOME`) and rejects:

- the account home, its parent, `/`, and critical system roots;
- recursive deletion of any top-level home entry, including expanded forms
  such as `rm -rf "$HOME"/*`;
- explicit `/bin/rm` and `/usr/bin/rm` commands that bypass the shim;
- common PATH bypasses including `PATH=... rm`, `command -p rm`, `env -i rm`,
  and `sudo ... rm`.

Guard creation is fail-closed and each session's private shim is removed during
shutdown. This protects commands executed through enhanced-bash; it is not an
OS sandbox and cannot intercept deletion performed through unrelated tools,
programming-language filesystem APIs, or scripts that invoke an absolute `rm`
internally.

## Lifecycle and output

Background output is written to capped log files. Completion and monitor output
are explicitly marked as untrusted before entering model context. Session
shutdown kills detached process trees and removes task directories.

## Shell selection

Foreground, background, and monitor execution honor Pi's configured `shellPath`
and `shellCommandPrefix`. Without an explicit shell, background execution uses
Bash-oriented platform discovery rather than Node's `/bin/sh` `shell:true`
default.
