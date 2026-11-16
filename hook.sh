#!/bin/sh
# AI Flows hook: Claude Code (or Codex) pipes one hook event as JSON on stdin.
# We keep a compact copy (no file contents, long text clipped) in a daily log
# that the dashboard server reads. Always exits 0 and prints nothing, so it can
# never block or steer the session.
#
# install-hooks.js copies this file to ~/.claude/ai-flows/hook.sh and passes
# the log folder as $1, so a project's environment cannot redirect the log or
# swap the programs used below. $2 names the tool when it is not Claude Code
# ("codex"); both tools send their events in the same shape.

PATH=/usr/bin:/bin
export PATH
# The log holds prompts and commands: keep it as private as Claude keeps its
# own transcripts (owner only).
umask 077
dir="${1:-$HOME/.claude/ai-flows}"
case "${2:-}" in
  codex) src=codex ;;
  *) src="" ;;
esac
/bin/mkdir -p "$dir" 2>/dev/null || exit 0

# macOS 15+ ships jq; older Macs usually have it from Homebrew. Only use a jq
# owned by root or by you, so another account cannot swap it.
JQ=""
for p in /usr/bin/jq /opt/homebrew/bin/jq /usr/local/bin/jq; do
  [ -x "$p" ] || continue
  owner=$(/usr/bin/stat -f %u "$p" 2>/dev/null)
  if [ "$owner" = 0 ] || [ "$owner" = "$(/usr/bin/id -u)" ]; then JQ=$p; break; fi
done
[ -n "$JQ" ] || exit 0

# HOME=/var/empty: jq would otherwise load ~/.jq, and HOME comes from Claude's
# environment. lockf: concurrent hooks append at once, and lines over ~4 KB
# would interleave. Every value is clipped before any regex runs: jq's gsub is
# quadratic, and a tool input can be a 100 KB heredoc.
HOME=/var/empty /usr/bin/lockf -k -t 5 "$dir/.lock" "$JQ" -c --arg ep "${CLAUDE_CODE_ENTRYPOINT:-}" --arg src "$src" '
  def clip($n): if type == "string" and length > $n then .[0:$n] + "…" else . end;
  def summary:
    if type == "object" then
      (.command // .description // .file_path // .notebook_path // .path // .pattern
        // .url // .query // .skill // .prompt // .title // "")
      | tostring | .[0:400] | gsub("\\s+"; " ") | clip(160)
    else "" end;
  def short_input: walk(if type == "string" then clip(1000) elif type == "array" then .[0:8] else . end);
  (.hook_event_name // "") as $ev
  | {
      ts: (now * 1000 | floor),
      ev: $ev,
      sid: .session_id,
      tp: .transcript_path,
      cwd: .cwd,
      mode: .permission_mode,
      ep: (if $src == "" then $ep else "" end),
      src: $src,
      aid: .agent_id,
      atype: .agent_type
    }
  + ( if $ev == "UserPromptSubmit" then {prompt: (.prompt | tostring | clip(600))}
      elif .tool_name != null then
        {tool: .tool_name, tuid: .tool_use_id, sum: (.tool_input | summary)}
        + ( if (.tool_name | test("^(AskUserQuestion|ExitPlanMode|mcp__ccd_turn__wrap_up)$"))
            then {input: (.tool_input | short_input)} else {} end )
      elif $ev == "Notification" then
        {msg: (.message | tostring | clip(400)), ntype: .notification_type, title: .title}
      elif $ev == "Stop" or $ev == "SubagentStop" then
        {last: (.last_assistant_message | if . == null then null else tostring | clip(1500) end)}
      elif $ev == "StopFailure" then
        {error: (.error | tostring | clip(300)), details: (.error_details | tostring | clip(300))}
      elif $ev == "SessionStart" then {source: .source, model: .model}
      elif $ev == "SessionEnd" then {reason: (.reason | tostring)}
      else {} end )
  | with_entries(select(.value != null and .value != ""))
' >> "$dir/events-$(/bin/date +%F).jsonl" 2>/dev/null

exit 0
