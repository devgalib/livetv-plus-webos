# Contributing to Live TV+

Thanks for helping! Bug reports, TV compatibility reports, channel fixes and code are all welcome.

## Reporting

- **Bugs:** open a [bug report](https://github.com/devgalib/livetv-plus-webos/issues/new?template=bug.yml)
  with your TV model, webOS version and what you pressed. The helper log helps a lot (see the README).
- **Works on my TV:** a [compatibility report](https://github.com/devgalib/livetv-plus-webos/issues/new?template=compatibility.yml)
  for models other than the tested 32LM636BPTB is very useful.
- **Channels:** broken stream, wrong category, or a removal request from a channel owner →
  [channel issue](https://github.com/devgalib/livetv-plus-webos/issues/new?template=channel.yml).

Never post your Developer Mode passphrase, SSH key (`~/.ssh/*_webos`) or `tools/.tvkey` in an issue.

## Making changes

1. Fork and clone, then `npm install`.
2. Make your change on a branch.
3. Run `npm run check`. It fails if `webos-app/app.js` or `webos-service/service.js` use anything
   beyond ES5: the TV runs Chrome 53 (webOS 4.5) and Node.js 0.12, so no `let`/`const`, arrow
   functions, template strings, `async`/`await`, spread or optional chaining in those files.
4. Test on a TV if you can (`npm run package && npm run install-tv`). If you can't, say so in the PR.
5. Open a pull request describing what changed and how you tested it.

### Code style

- Match the surrounding code; 2-space indent, single quotes, semicolons.
- Keep the TV fast: render only what is visible, avoid layout thrashing, no heavy libraries.
- Size UI in `rem` (the root font scales with screen height) so 720p and 1080p look the same.

### Channels

`webos-app/channels.js` is generated. Don't edit it by hand. Change the rules in
`scripts/build-channels.mjs` (categories, featured order, blocked words) and run `npm run channels`.
Adult, religious and shopping channels must stay excluded.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE) and
that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).
