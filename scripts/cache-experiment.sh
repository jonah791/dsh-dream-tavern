#!/usr/bin/env bash
# A4 实验：连跑 N 轮，检验「只追加 ⇒ 缓存命中率不塌」。
#
# 判据（跑之前写死）：
#   ① 每轮 A1 必须为真（装配单与实际请求逐字节一致）；
#   ② requestChars 单调不减（只追加，不重写已发前缀）；
#   ③ cacheRead 命中比不塌——若随轮次下降，则「只追加」在真实链路上不成立。
#
# 依赖：本机 web 在 3080 且 dsh-dream-tavern 已挂载、panel 宿主在线。
# 跑法：
#   bash scripts/cache-experiment.sh [会话名] [轮数] [卡 id]
#
# ⚠ 读数按**服务端返回的 usage**原样记录，不推算、不美化。

set -u
SESSION="${1:-a4exp}"
TURNS="${2:-6}"
CARD="${3:-}"
PORT="${DSH_WEB_PORT:-3080}"
BASE="http://127.0.0.1:${PORT}/api/panel/action"

if [ -z "$CARD" ]; then
  echo "需要卡 id：bash scripts/cache-experiment.sh <会话名> <轮数> <卡 id>" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for i in $(seq 1 "$TURNS"); do
  curl -sS --max-time 120 -X POST -H 'content-type: application/json' \
    -d "{\"panelId\":\"dream-tavern\",\"actionId\":\"play\",\"params\":{\"session\":\"${SESSION}\",\"cardId\":\"${CARD}\",\"input\":\"第${i}步：我保持安静，继续观察。\"}}" \
    "$BASE" -o "$TMP/$i.json"
  printf '.'
done
printf '\n'

python3 - "$TMP" <<'PY'
import json, sys, glob, os
rows = []
for f in sorted(glob.glob(os.path.join(sys.argv[1], '*.json')), key=lambda p: int(os.path.basename(p)[:-5])):
    d = json.load(open(f, encoding='utf-8'))
    x = d.get('data') or {}
    rows.append({'ok': d.get('ok'), 'turn': x.get('turn'), 'chars': x.get('requestChars'),
                 'inp': x.get('inputTokens'), 'cr': x.get('cacheReadTokens'),
                 'a1': x.get('a1Ok'), 'msg': d.get('message')})

print(f"{'轮':>4} {'请求字数':>8} {'新增tok':>8} {'缓存读tok':>9} {'命中比':>7}  A1")
for r in rows:
    total = (r['inp'] or 0) + (r['cr'] or 0)
    hit = (r['cr'] or 0) / total if total else None
    print(f"{str(r['turn']):>4} {str(r['chars']):>8} {str(r['inp']):>8} {str(r['cr']):>9} "
          f"{(f'{hit:.1%}' if hit is not None else '-'):>7}  {r['a1']}"
          + ('' if r['ok'] else f"  ⚠ {r['msg']}"))

chars = [r['chars'] for r in rows if r['ok']]
crs = [r['cr'] for r in rows if isinstance(r['cr'], int)]
hits = [(r['cr'] or 0) / ((r['inp'] or 0) + (r['cr'] or 0)) for r in rows if ((r['inp'] or 0) + (r['cr'] or 0))]

print()
print('① 全轮 A1 为真        :', all(r['a1'] for r in rows if r['ok']))
print('② requestChars 单调不减:', chars == sorted(chars), chars)
print('③ cacheRead 单调不减   :', crs == sorted(crs), crs)
if len(hits) >= 2:
    print(f'④ 命中比 首轮 {hits[0]:.1%} → 末轮 {hits[-1]:.1%}（{"未塌" if hits[-1] >= hits[0] else "塌了"}）')
PY
