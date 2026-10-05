### Fixed

- **`@reticlehq/engine` — a held `anyOf` assertion could be downgraded to `outcome_unread` when a response body was not recorded.** Assertions whose branches are all independent of the response body, such as a route-or-element check, now retain their `verified: "yes"` result. An `anyOf` containing a network branch remains conservative and still requires the response body. Closes [#1354](https://github.com/reticlehq/reticle/issues/1354).
