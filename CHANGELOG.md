# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [1.1.1] - 2026-11-10

### Fixed
- After the TV restarted, the Home helper could not save its state and reopened Live TV+ every
  10 seconds, pulling you out of YouTube and other apps. State now falls back to rewriting the
  existing file or `/tmp`, the boot launch only happens once and only if that was saved, and only
  within 5 minutes of power-on.
- The LG Home check waits 3.5 s, so apps that take a moment to start are no longer pulled back.

## [1.1.0] - 2026-11-07

### Added
- Home screen in the style of the cleanyourtv webOS ports: live channel behind, an Apps dock with the
  TV's own apps, and Favourites / News / Kids / Movies / Music rows.
- Home helper service: opens Live TV+ at boot, brings it back over the antenna "No signal" screen and
  over LG Home, lists and launches apps. Press Home three times to pause it; Blue resumes.
- `tools/tv.js` remote helper (keys, screenshots, foreground app) and `tools/set-passphrase.sh`.
- `npm run check` for ES5 and manifest checks; CI builds the `.ipk`.

### Fixed
- The channel list no longer cuts its last row in half.

## 1.0.0 - 2026-11-07

### Added
- Full-screen live TV player for webOS with a channel list, channel numbers, favourites and a
  startup channel that falls back to other news channels when off air.
- Channel builder that test-plays every iptv-org stream before keeping it.

[1.1.1]: https://github.com/devgalib/livetv-plus-webos/releases/tag/v1.1.1
[1.1.0]: https://github.com/devgalib/livetv-plus-webos/releases/tag/v1.1.0
