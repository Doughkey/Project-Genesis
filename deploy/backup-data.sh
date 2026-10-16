#!/bin/sh
set -eu
umask 077

volume_name=${MATANGLAWIN_DATA_VOLUME:-matanglawin-production-data}
backup_dir=${BACKUP_DIR:-"$PWD/backups"}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)

mkdir -p "$backup_dir"
docker run --rm \
  -v "$volume_name:/source:ro" \
  -v "$backup_dir:/backup" \
  busybox:1.37.0 \
  tar -czf "/backup/matanglawin-data-${timestamp}.tar.gz" -C /source .

chmod 600 "$backup_dir/matanglawin-data-${timestamp}.tar.gz"
printf 'Backup created: %s/matanglawin-data-%s.tar.gz\n' "$backup_dir" "$timestamp"
