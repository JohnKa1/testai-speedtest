#!/bin/sh
set -eu

json_escape() {
  printf '%s' "$1" | tr '\r\n\t' '   ' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

parse_stream_count() {
  val="$1"
  fallback="$2"
  case "$val" in
    ''|*[!0-9]*)
      printf '%s' "$fallback"
      return
      ;;
  esac
  if [ "$val" -lt 1 ]; then
    printf '%s' "1"
  elif [ "$val" -gt 8 ]; then
    printf '%s' "8"
  else
    printf '%s' "$val"
  fi
}

ISP_NAME_VAL="${ISP_NAME:-TestAi}"
SERVER_LABEL_VAL="${SERVER_LABEL:-On-Net Server}"
MEASUREMENT_MODE_RAW="${MEASUREMENT_MODE:-commercial}"
DL_STREAMS_RAW="${PARALLEL_DOWNLOAD_STREAMS:-6}"
UL_STREAMS_RAW="${PARALLEL_UPLOAD_STREAMS:-4}"

case "$MEASUREMENT_MODE_RAW" in
  sustained|commercial)
    MEASUREMENT_MODE_VAL="$MEASUREMENT_MODE_RAW"
    ;;
  *)
    MEASUREMENT_MODE_VAL="commercial"
    ;;
esac

DL_STREAMS_VAL="$(parse_stream_count "$DL_STREAMS_RAW" 6)"
UL_STREAMS_VAL="$(parse_stream_count "$UL_STREAMS_RAW" 4)"
ISP_NAME_ESC="$(json_escape "$ISP_NAME_VAL")"
SERVER_LABEL_ESC="$(json_escape "$SERVER_LABEL_VAL")"

cat <<EOF > /usr/share/nginx/html/config.json
{
  "ispName": "${ISP_NAME_ESC}",
  "serverLabel": "${SERVER_LABEL_ESC}",
  "measurementMode": "${MEASUREMENT_MODE_VAL}",
  "parallelStreams": {
    "download": ${DL_STREAMS_VAL},
    "upload": ${UL_STREAMS_VAL}
  },
  "endpoints": {
    "down": "/api/down",
    "up": "/api/up",
    "ping": "/api/ping",
    "meta": "/api/meta"
  }
}
EOF

exec nginx -g "daemon off;"
