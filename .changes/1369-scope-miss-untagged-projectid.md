### Fixed

- **@reticlehq/server — scope-miss errors printed 'untagged' as if it were a valid project id.** When browser sessions connect without a projectId, the error now clarifies they are connected with no projectId, shows (no projectId: the page's connect() carries none), and guides adding projectId to connect() or .reticle.json alongside sessionId targeting. Closes [#1369](https://github.com/reticlehq/reticle/issues/1369).
