#!/bin/sh
# Ежедневная копия базы склада; хранятся последние 30 дней.
# Запускается из cron (см. deploy/cron), вручную: sh deploy/backup.sh
set -e

cd "$(dirname "$0")/.."
DEST=/var/backups/sklad
mkdir -p "$DEST"
chmod 700 "$DEST"

# копия делается средствами SQLite внутри контейнера, сервис при этом не останавливается
docker compose exec -T app node -e "
const D = require('better-sqlite3');
new D('/data/sklad.db', { readonly: true }).backup('/data/backup-tmp.db')
  .then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
"
gzip -c data/backup-tmp.db > "$DEST/sklad-$(date +%F).db.gz"
rm -f data/backup-tmp.db

find "$DEST" -name 'sklad-*.db.gz' -mtime +30 -delete
