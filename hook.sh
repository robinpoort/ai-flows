#!/bin/sh
# AI Flows hook: Claude Code pipes one hook event as JSON on stdin.
# We keep a compact copy (no file contents, long text clipped) in a daily log
# that the dashboard server reads. Always exits 0 so it can never block Claude.

dir="${AI_FLOWS_DIR:-$HOME/.claude/ai-flows}"
mkdir -p "$dir" 2>/dev/null || exit 0
# macOS 15+ ships jq; older Macs usually have it from Homebrew, which may not
# be on the PATH that Claude Code hands to hooks.
JQ=""
for p in /usr/bin/jq /opt/homebrew/bin/jq /usr/local/bin/jq; do
  [ -x "$p" ] && JQ=$p && break
done
[ -n "$JQ" ] || JQ=$(command -v jq) || exit 0

"$JQ" -c --arg ep "${CLAUDE_CODE_ENTRYPOINT:-}" '
  def clip($n): if type == "string" and length > $n then .[0:$n] + "…" else . end;
  def summary:
    if type == "object" then
      (.command // .description // .file_path // .notebook_path // .path // .pattern
        // .url // .query // .skill // .prompt // .title // "")
      | tostring | gsub("\\s+"; " ") | clip(160)
    else "" end;
  def short_input: walk(if type == "string" then clip(3000) else . end);
  (.hook_event_name // "") as $ev
  | {
      ts: (now * 1000 | floor),
      ev: $ev,
      sid: .session_id,
      tp: .transcript_path,
      cwd: .cwd,
      mode: .permission_mode,
      ep: $ep,
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
        {last: (.last_assistant_message | if . == null then null else tostring | clip(4000) end)}
      elif $ev == "StopFailure" then
        {error: (.error | tostring | clip(300)), details: (.error_details | tostring | clip(300))}
      elif $ev == "SessionStart" then {source: .source, model: .model}
      elif $ev == "SessionEnd" then {reason: (.reason | tostring)}
      else {} end )
  | with_entries(select(.value != null and .value != ""))
' >> "$dir/events-$(date +%F).jsonl" 2>/dev/null

exit 0
