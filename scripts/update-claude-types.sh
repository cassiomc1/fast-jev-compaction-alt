#!/usr/bin/env bash
set -euo pipefail

# update-claude-types.sh
# Regenerates types/claude-code.d.ts using Claude Code's internal `/plugin-types` command.
#
# Prerequisites:
#   - Claude Code 2.1.274 or newer installed
#   - Function hooks enabled (CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1)
#
# Usage:
#   ./scripts/update-claude-types.sh

echo "To update Claude Code types:"
echo "1. Run Claude Code: CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude"
echo "2. Inside the session, run: /plugin-types"
echo "3. Copy output to types/claude-code.d.ts"
