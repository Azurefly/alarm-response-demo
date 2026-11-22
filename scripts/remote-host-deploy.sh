#!/usr/bin/env bash
set -euo pipefail

image=${1:?image required}
release=${2:?release directory required}
state=${3:?state directory required}
origin=${4:?HTTPS origin required}
name=alarm-response-demo
snippet=/etc/nginx/snippets/alarm-response-demo.conf
site=/etc/nginx/conf.d/flow-ai-engine-https.conf
test -r "$release/src/server.mjs" && test -r "$state/config.json" && test -d "$state/ledger"
docker image inspect "$image" >/dev/null
test -f "$site" && test ! -L "$site"
old="$name-rollback-$(date +%s)"
previous=false
launched=false
added=false
backup=

rollback() {
  local status=$?
  if [ "$status" -eq 0 ]; then return; fi
  if [ "$added" = true ]; then
    install -m 0644 "$backup" "$site"
    nginx -t && systemctl reload nginx || true
    rm -f -- "$snippet"
  fi
  if [ "$launched" = true ]; then docker rm -f "$name" >/dev/null || true; fi
  if [ "$previous" = true ]; then
    docker rename "$old" "$name" && docker start "$name" >/dev/null || true
  fi
  exit "$status"
}
trap rollback EXIT

if docker container inspect "$name" >/dev/null 2>&1; then
  test "$(docker inspect -f '{{ index .Config.Labels "org.flowai.alarm.demo" }}' "$name")" = true
  docker stop "$name" >/dev/null
  docker rename "$name" "$old"
  previous=true
fi

docker run -d --name "$name" --label org.flowai.alarm.demo=true --label "org.flowai.alarm.release=$release" \
  --restart unless-stopped --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1:1182:8080 -v "$release:/demo:ro" -v "$state/config.json:/run/alarm-config.json:ro" \
  -v "$state/ledger:/ledger:rw" -e ALARM_BIND=0.0.0.0 -e "ALARM_PUBLIC_ORIGIN=$origin" \
  -e ALARM_CONFIG_FILE=/run/alarm-config.json -e ALARM_LEDGER_FILE=/ledger/alarms.json \
  --entrypoint node "$image" /demo/src/server.mjs >/dev/null
launched=true
for attempt in {1..25}; do
  if curl -fsS --max-time 2 http://127.0.0.1:1182/alarm-demo/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS --max-time 5 http://127.0.0.1:1182/alarm-demo/healthz >/dev/null

if ! grep -Fxq "    include $snippet;" "$site"; then
  test ! -e "$snippet"
  backup=$(mktemp "$site.alarm-backup.XXXXXXXX")
  install -m 0644 "$site" "$backup"
  cat >"$snippet" <<'NGINX'
location = /alarm-demo {
    return 308 /alarm-demo/;
}
location ^~ /alarm-demo/ {
    proxy_pass http://127.0.0.1:1182;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Connection "";
    proxy_read_timeout 40s;
}
NGINX
  chmod 0644 "$snippet"
  added=true
  python3 - "$site" "$snippet" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
value = path.read_text(encoding='utf-8')
anchor = '    location / {'
if value.count(anchor) != 1:
    raise SystemExit('Unable to locate the expected Flow AI Engine main route')
updated = value.replace(anchor, f'    include {sys.argv[2]};\n\n{anchor}', 1)
temporary = path.with_suffix('.alarm-tmp')
temporary.write_text(updated, encoding='utf-8')
temporary.chmod(0o644)
temporary.replace(path)
PY
  nginx -t
  systemctl reload nginx
fi

curl -fsS --max-time 12 "$origin/alarm-demo/healthz" >/dev/null
curl -fsS --max-time 12 "$origin/readyz" >/dev/null
if [ "$previous" = true ]; then docker rm "$old" >/dev/null; fi
printf 'Demo healthy at %s/alarm-demo/\n' "$origin"
