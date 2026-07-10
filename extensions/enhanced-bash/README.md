# enhanced-bash

Overrides Pi's `bash` tool with non-interactive foreground defaults and UI-only
background jobs. Background output is written to capped log files, completion
is reported back to the interactive session, and shutdown kills the detached
process tree.

`background:true` is rejected in Pi print (`-p`) and JSON modes. Those modes
exit after the turn, and a background process that inherits a pipe could keep
the Pi process alive.

## Shell selection

Foreground and background execution both honor Pi's configured `shellPath` and
`shellCommandPrefix`. Without an explicit shell, background mode uses
Bash-oriented platform discovery rather than Node's `/bin/sh` `shell:true`
default.
