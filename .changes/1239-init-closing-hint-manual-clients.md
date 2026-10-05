### Fixed

- **`@reticlehq/init` — the closing hint of `reticle init` said the tools were "available now" right below a Codex row that said to add the block by hand.** The hint only read the Claude Code row, so with Claude Code already registered and another client still left to hand-edit, a reader saw two contradicting lines and believed the last one. The hint now names the clients whose step still needs a hand edit and says the tools are not available there until it is done. Closes [#1239](https://github.com/reticlehq/reticle/issues/1239).
