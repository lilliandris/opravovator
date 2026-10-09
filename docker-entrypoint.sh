#!/bin/sh
# Disk s dátami (Fly volume, bind mount…) môže patriť rootovi – odovzdaj ho používateľovi node
# a aplikáciu spusti už bez root práv.
set -e
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown node:node "$DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
