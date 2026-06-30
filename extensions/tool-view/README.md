# tool-view

Granular control over how built-in tool calls (`read`, `write`, `edit`, `bash`,
`grep`, `find`, `ls`) are displayed in the TUI. Three verbosity modes:

> Note: `tool-view` works by re-registering the built-in tools, so it cannot
> manage a tool that another extension already owns. It auto-detects such
> extensions and defers. In this agent dir, `enhanced-bash` owns `bash`, so
> `bash` is left untouched (its output stays verbose). See **Excluding tools**.

| Mode        | What you see                                                            |
| ----------- | ----------------------------------------------------------------------- |
| `minimized` | Just which tool ran + its target (path/command). No output body.        |
| `medium`    | Everything as normal, **except** `write`/`edit` — their content & diffs are hidden. |
| `verbose`   | Full native output (pi default).                                        |

Errors are always shown, even in stripped modes.

## Usage

```
/toolview            # cycle minimized → medium → verbose
/toolview minimized
/toolview medium
/toolview verbose
```

The current mode is shown in the status bar (`tools: <mode>`) and persisted to
`~/.pi/agent/tool-view.json`, so it survives restarts. Mode changes apply to
subsequent tool calls.

## Excluding tools

`tool-view` automatically skips built-ins owned by sibling extensions (e.g.
`bash` while `enhanced-bash` is installed) to avoid conflicts. You can also opt
tools out manually via `~/.pi/agent/tool-view.json`:

```json
{
  "version": 1,
  "mode": "medium",
  "exclude": ["bash", "grep"]
}
```

To let `tool-view` manage `bash` instead, remove/disable `enhanced-bash`.

## Compact rows

In all modes the managed tools render with `renderShell: "self"` and re-wrap
their content in a `Box` with **no vertical padding** (the default shell adds a
blank tinted line above and below every row). The background tint and horizontal
padding are preserved, so rows look native but take far less vertical space.

## How it works

The extension overrides the built-in tools, reusing their original
`create*ToolDefinition` factories so execution and (in verbose/medium) rendering
stay 100% native. Only the `renderCall` / `renderResult` slots are wrapped: in
stripped modes they return a compact one-line header and an empty result body;
otherwise they delegate straight to pi's built-in renderers. The wrapped
components are placed in a zero-vertical-padding `Box` to tighten the layout.

Because it re-registers built-in tools, pi prints a one-time "overriding
built-in tool" notice on startup. That is expected.
