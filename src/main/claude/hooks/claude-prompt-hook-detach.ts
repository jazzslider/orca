import { AGENT_HOOK_METADATA_CACHE_DIR } from '../../../shared/agent-hook-listener/transport/agent-hook-spool'

// Why: a background prompt post holds at most curl's 0.5 s connect + 1.5 s transfer plus `ps`; wait a bit longer, then drop it as stale.
const PENDING_WAIT_STEPS = 250
const PENDING_WAIT_STEP_SECONDS = '0.01'

/**
 * Claude waits for every UserPromptSubmit hook before it sends the model request. Its reply is
 * always `{}`, so that event prints first and posts in the background. A per-pane marker keeps
 * order: each later event from the pane waits for the pending post before it posts.
 * `deliverLines` are the script's remaining lines (identity capture, post, `exit 0`).
 */
export function wrapPosixPromptHookDetach(deliverLines: readonly string[]): string[] {
  return [
    'orca_hook_pending= orca_hook_detach=',
    'if [ -n "${ORCA_PANE_KEY:-}" ] && [ -r "${ORCA_AGENT_HOOK_ENDPOINT:-}" ]; then',
    '  orca_hook_pending_id=$ORCA_PANE_KEY',
    '  while :; do case "$orca_hook_pending_id" in *[/:]*) orca_hook_pending_id="${orca_hook_pending_id%%[/:]*}_${orca_hook_pending_id#*[/:]}" ;; *) break ;; esac; done',
    `  orca_hook_pending="\${ORCA_AGENT_HOOK_ENDPOINT%/*}/${AGENT_HOOK_METADATA_CACHE_DIR}/pane-$orca_hook_pending_id.pending"`,
    'fi',
    'orca_hook_wait_pending() {',
    '  [ -n "$orca_hook_pending" ] && [ -e "$orca_hook_pending" ] || return 0',
    '  orca_hook_waits=0',
    `  while [ -e "$orca_hook_pending" ] && [ "$orca_hook_waits" -lt ${PENDING_WAIT_STEPS} ]; do sleep ${PENDING_WAIT_STEP_SECONDS} 2>/dev/null || break; orca_hook_waits=$((orca_hook_waits + 1)); done`,
    // A post killed mid-flight leaves its marker; one bounded wait clears it.
    '  rm -f "$orca_hook_pending" 2>/dev/null || :',
    '}',
    'orca_hook_deliver() {',
    ...deliverLines.map((line) => `  ${line}`),
    '}',
    'case "$payload" in',
    `  *'"hook_event_name":"UserPromptSubmit"'*|*'"hook_event_name": "UserPromptSubmit"'*)`,
    '    if [ -z "${orca_hook_decides:-}" ] && [ -n "$orca_hook_pending" ] && { [ -d "${orca_hook_pending%/*}" ] || mkdir -m 700 "${orca_hook_pending%/*}" 2>/dev/null; }; then',
    '      orca_hook_wait_pending',
    '      { : > "$orca_hook_pending"; } 2>/dev/null && orca_hook_detach=1',
    '    fi ;;',
    'esac',
    'if [ -n "$orca_hook_detach" ]; then',
    // Closed stdio lets Claude read the hook's `{}` and move on while the post finishes.
    '  ( trap \'rm -f "$orca_hook_pending" 2>/dev/null\' EXIT; orca_hook_deliver ) </dev/null >/dev/null 2>&1 &',
    '  exit 0',
    'fi',
    'orca_hook_wait_pending',
    'orca_hook_deliver'
  ]
}
