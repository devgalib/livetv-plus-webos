#!/usr/bin/env bash
# Saves the Developer Mode passphrase for the "tv" device without echoing it,
# then checks that the TV accepts the developer connection.
set -e
cd "$(dirname "$0")/.."
read -r -s -p "Passphrase shown on the TV (6 characters): " pass
echo
./node_modules/.bin/ares-setup-device --modify tv --info "passphrase=$pass" >/dev/null
if ./node_modules/.bin/ares-device -i --device tv >/dev/null 2>&1; then
  echo "=== OK: the TV accepted the passphrase. Tell Claude 'done'. ==="
else
  echo "=== The TV rejected it. Check the passphrase on the TV screen and run this again. ==="
fi
