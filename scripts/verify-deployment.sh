#!/usr/bin/env bash
set -Eeuo pipefail

# End-to-end checks for the deployed Worker. This sends short real model requests.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

WORKER_URL="${WORKER_URL:-https://ai.444002.xyz}"
DEFAULT_MODEL="${VERIFY_MODEL:-nvidia/nemotron-3-ultra-550b-a55b:free}"
ANTHROPIC_MODEL="${VERIFY_ANTHROPIC_MODEL:-$DEFAULT_MODEL}"
OPENAI_CHAT_MODEL="${VERIFY_OPENAI_CHAT_MODEL:-$DEFAULT_MODEL}"
OPENAI_RESPONSES_MODEL="${VERIFY_OPENAI_RESPONSES_MODEL:-$DEFAULT_MODEL}"
GEMINI_MODEL="${VERIFY_GEMINI_MODEL:-gemini-2.5-flash}"
MAX_TIME="${VERIFY_MAX_TIME:-90}"
CONFIG="wrangler.jsonc"
[[ -f wrangler.local.jsonc ]] && CONFIG="wrangler.local.jsonc"

for command in curl jq; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required command: $command" >&2; exit 2; }
done
[[ "$WORKER_URL" == https://* ]] || { echo "WORKER_URL must use HTTPS." >&2; exit 2; }
WORKER_URL="${WORKER_URL%/}"

read_dev_var() {
  local name="$1"
  [[ -f .dev.vars ]] || return 0
  awk -v name="$name" 'index($0, name "=") == 1 { print substr($0, length(name) + 2); exit }' .dev.vars
}

PROXY_TOKEN="${PROXY_TOKEN:-$(read_dev_var PROXY_TOKEN)}"
if [[ -z "$PROXY_TOKEN" ]]; then
  echo "Set PROXY_TOKEN or add it to ignored .dev.vars before running this script." >&2
  exit 2
fi

TMP_DIR="$(mktemp -d)"
chmod 700 "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT
umask 077
printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "$PROXY_TOKEN" > "$TMP_DIR/auth.curl"
unset PROXY_TOKEN

PASS=0
FAIL=0

report() {
  local name="$1" status="$2" expected="$3" body_file="$4"
  if eval "$expected"; then
    printf 'PASS  %s (HTTP %s)\n' "$name" "$status"
    PASS=$((PASS + 1))
  else
    printf 'FAIL  %s (HTTP %s)\n' "$name" "${status:-000}"
    if [[ -s "$body_file" ]]; then
      local message
      message="$(jq -r '.error.message // .error // empty' "$body_file" 2>/dev/null | head -c 240 || true)"
      [[ -z "$message" ]] || printf '      %s\n' "$message"
    fi
    FAIL=$((FAIL + 1))
  fi
}

post_request() {
  local name="$1" path="$2" body="$3" expected="$4" extra_header="${5:-}"
  local result="$TMP_DIR/response" status
  local -a args=(--silent --show-error --no-buffer --connect-timeout 15 --max-time "$MAX_TIME"
    --config "$TMP_DIR/auth.curl" --data-binary "@$body" --output "$result" --write-out '%{http_code}')
  [[ -z "$extra_header" ]] || args+=(--header "$extra_header")
  status="$(curl "${args[@]}" --request POST "$WORKER_URL$path" 2>/dev/null || true)"
  report "$name" "$status" "$expected" "$result"
}

make_json() { jq -cn "$@"; }
valid_chat_response() {
  jq -e '(.choices[0].message.content | if type == "string" then length > 0 elif type == "array" then length > 0 else false end)' "$1" >/dev/null 2>&1
}

echo "Checking Worker authentication and method handling at $WORKER_URL"
status="$(curl --silent --show-error --output "$TMP_DIR/unauthorized" --write-out '%{http_code}' \
  --request POST --header 'Content-Type: application/json' --data '{}' "$WORKER_URL/anthropic/v1/messages" 2>/dev/null || true)"
report 'reject missing gateway token' "$status" '[[ "$status" == 401 ]]' "$TMP_DIR/unauthorized"

status="$(curl --silent --show-error --output "$TMP_DIR/unknown" --write-out '%{http_code}' \
  --config "$TMP_DIR/auth.curl" --request POST --header 'Content-Type: application/json' --data '{}' "$WORKER_URL/not-a-route" 2>/dev/null || true)"
report 'reject unknown path' "$status" '[[ "$status" == 404 ]]' "$TMP_DIR/unknown"

status="$(curl --silent --show-error --output "$TMP_DIR/method" --write-out '%{http_code}' \
  --config "$TMP_DIR/auth.curl" --request GET "$WORKER_URL/anthropic/v1/messages" 2>/dev/null || true)"
report 'reject unsupported HTTP method' "$status" '[[ "$status" == 405 ]]' "$TMP_DIR/method"

echo "Checking non-streaming model responses (OpenRouter model: $DEFAULT_MODEL; Gemini model: $GEMINI_MODEL)"
body="$(make_json --arg model "$ANTHROPIC_MODEL" '{model:$model,max_tokens:96,messages:[{role:"user",content:"Reply with exactly OK."}]}')"
printf '%s' "$body" > "$TMP_DIR/request.json"
post_request 'Anthropic Messages' '/anthropic/v1/messages' "$TMP_DIR/request.json" \
  '[[ "$status" =~ ^2[0-9][0-9]$ ]] && jq -e "(.content | length) > 0" "$TMP_DIR/response" >/dev/null 2>&1' \
  'anthropic-version: 2023-06-01'
body="$(make_json --arg model "$OPENAI_CHAT_MODEL" '{model:$model,max_tokens:96,messages:[{role:"user",content:"Reply with exactly OK."}]}')"
printf '%s' "$body" > "$TMP_DIR/request.json"
post_request 'OpenAI Chat Completions' '/openai/v1/chat/completions' "$TMP_DIR/request.json" \
  '[[ "$status" =~ ^2[0-9][0-9]$ ]] && valid_chat_response "$TMP_DIR/response"'

body="$(make_json --arg model "$OPENAI_RESPONSES_MODEL" '{model:$model,max_output_tokens:96,input:"Reply with exactly OK."}')"
printf '%s' "$body" > "$TMP_DIR/request.json"
post_request 'OpenAI Responses' '/openai/v1/responses' "$TMP_DIR/request.json" \
  '[[ "$status" =~ ^2[0-9][0-9]$ ]] && jq -e "(.output | length) > 0" "$TMP_DIR/response" >/dev/null 2>&1'

if [[ "$GEMINI_MODEL" == */* || "$GEMINI_MODEL" == *:* ]]; then
  echo "VERIFY_GEMINI_MODEL must be a Gemini API model name without slash or colon." >&2
  exit 2
fi
body="$(make_json --arg model "$GEMINI_MODEL" '{contents:[{parts:[{text:"Reply with exactly OK."}]}],generationConfig:{maxOutputTokens:96}}')"
printf '%s' "$body" > "$TMP_DIR/request.json"
post_request 'Gemini generateContent' "/gemini/v1beta/models/${GEMINI_MODEL}:generateContent" "$TMP_DIR/request.json" \
  '[[ "$status" =~ ^2[0-9][0-9]$ ]] && jq -e "(.candidates[0].content.parts | length) > 0" "$TMP_DIR/response" >/dev/null 2>&1'

echo "Checking streaming responses"
body="$(make_json --arg model "$ANTHROPIC_MODEL" '{model:$model,max_tokens:96,stream:true,messages:[{role:"user",content:"Reply with exactly OK."}]}')"
printf '%s' "$body" > "$TMP_DIR/request.json"
post_request 'Anthropic Messages stream' '/anthropic/v1/messages' "$TMP_DIR/request.json" \
  '[[ "$status" =~ ^2[0-9][0-9]$ ]] && grep -q "message_stop" "$TMP_DIR/response"' \
  'anthropic-version: 2023-06-01'
body="$(make_json --arg model "$OPENAI_CHAT_MODEL" '{model:$model,max_tokens:96,stream:true,messages:[{role:"user",content:"Reply with exactly OK."}]}')"
printf '%s' "$body" > "$TMP_DIR/request.json"
post_request 'OpenAI Chat Completions stream' '/openai/v1/chat/completions' "$TMP_DIR/request.json" \
  '[[ "$status" =~ ^2[0-9][0-9]$ ]] && grep -Fq "[DONE]" "$TMP_DIR/response"'

body="$(make_json --arg model "$OPENAI_RESPONSES_MODEL" '{model:$model,max_output_tokens:96,stream:true,input:"Reply with exactly OK."}')"
printf '%s' "$body" > "$TMP_DIR/request.json"
post_request 'OpenAI Responses stream' '/openai/v1/responses' "$TMP_DIR/request.json" \
  '[[ "$status" =~ ^2[0-9][0-9]$ ]] && { grep -q "response.completed" "$TMP_DIR/response" || grep -Fq "[DONE]" "$TMP_DIR/response"; }'

body="$(make_json --arg model "$GEMINI_MODEL" '{contents:[{parts:[{text:"Reply with exactly OK."}]}],generationConfig:{maxOutputTokens:96}}')"
printf '%s' "$body" > "$TMP_DIR/request.json"
post_request 'Gemini streamGenerateContent' "/gemini/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse" "$TMP_DIR/request.json" \
  '[[ "$status" =~ ^2[0-9][0-9]$ ]] && grep -Eq "^data:.*candidates" "$TMP_DIR/response"'

printf '\nResult: %d passed, %d failed\n' "$PASS" "$FAIL"
if (( FAIL > 0 )); then
  echo "A 404 'Provider not found' means that protocol has no enabled provider record in D1." >&2
  exit 1
fi
