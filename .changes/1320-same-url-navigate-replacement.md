### Fixed

- **`@reticlehq/server` — `reticle_navigate` to the page already shown no longer confirms before the document is replaced.** The arrival scan returned the still-connected old document as if the navigation had landed, so a replay started immediately afterward could lose its document — reported on a sign-in flow that redirects to `/login`. A same-page navigation now confirms only when the replacement reports a different document identity, or when the session reconnects under a new id. Closes [#1320](https://github.com/reticlehq/reticle/issues/1320).
