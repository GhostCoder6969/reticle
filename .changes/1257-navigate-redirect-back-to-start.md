### Fixed

- **`@reticlehq/server` — `reticle_navigate` reported a redirect back to the page you started on as an arrival that went nowhere.** At `/login`, navigating to `/checkout` and being bounced back to `/login` by an auth guard answered a plain unconfirmed result with no `landedOn`, which read like navigate could not move the tab. When the page unloads and the tab reconnects on the page it started from, the result now carries `landedOn`, as for any other redirect. Closes [#1257](https://github.com/reticlehq/reticle/issues/1257).
