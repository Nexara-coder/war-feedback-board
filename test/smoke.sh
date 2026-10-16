#!/bin/sh
# End-to-end permission test: public can submit, only admin can moderate.
# Usage: npm test   (starts its own server on port 3999 with a throwaway password)
set -e
cd "$(dirname "$0")/.."
PORT=3999 ADMIN_PASSWORD=testpass SESSION_SECRET=test-secret DOTENV_CONFIG_PATH=/dev/null node server.js >/dev/null 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -f "$JAR"' EXIT
JAR=$(mktemp)
sleep 1.5
B=http://localhost:3999
fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1 (expected $3, got $2)"; fail=1; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

ID=$(curl -s -X POST $B/api/tasks -H 'Content-Type: application/json' \
  -d '{"title":"Smoke test report","priority":"high","reporter":"CI"}' | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$ID" ] && echo "PASS  public can submit a report" || { echo "FAIL  public submit"; fail=1; }
check "public read"                     "$(code $B/api/tasks)" 200
check "public move is rejected"         "$(code -X PATCH $B/api/tasks/$ID -H 'Content-Type: application/json' -d '{"status":"active"}')" 401
check "public edit is rejected"         "$(code -X PATCH $B/api/tasks/$ID -H 'Content-Type: application/json' -d '{"title":"x"}')" 401
check "public delete is rejected"       "$(code -X DELETE $B/api/tasks/$ID)" 401
check "public clear is rejected"        "$(code -X DELETE $B/api/tasks)" 401
check "wrong password is rejected"      "$(code -X POST $B/api/login -H 'Content-Type: application/json' -d '{"password":"nope"}')" 401
check "admin login"                     "$(code -c $JAR -X POST $B/api/login -H 'Content-Type: application/json' -d '{"password":"testpass"}')" 200
check "admin move"                      "$(code -b $JAR -X PATCH $B/api/tasks/$ID -H 'Content-Type: application/json' -d '{"status":"active"}')" 200
check "admin edit"                      "$(code -b $JAR -X PATCH $B/api/tasks/$ID -H 'Content-Type: application/json' -d '{"title":"Edited","priority":"critical"}')" 200
check "invalid status is rejected"      "$(code -b $JAR -X PATCH $B/api/tasks/$ID -H 'Content-Type: application/json' -d '{"status":"bogus"}')" 400
check "admin delete"                    "$(code -b $JAR -X DELETE $B/api/tasks/$ID)" 200
exit $fail
