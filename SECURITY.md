# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please report security problems privately through
[GitHub's private vulnerability reporting](https://github.com/devgalib/livetv-plus-webos/security/advisories/new),
not in a public issue. You will get a reply within a week.

## Notes for users

- The Developer Mode passphrase, the SSH key that `ares-novacom --getkey` saves in `~/.ssh/`, and the
  pairing key in `tools/.tvkey` give control of your TV on your local network. Keep them private;
  they are git-ignored here.
- The Home helper only talks to the TV's own control API on `127.0.0.1`/the TV's LAN address. The app
  loads streams and logos from the public addresses in `webos-app/channels.js` and nothing else.
