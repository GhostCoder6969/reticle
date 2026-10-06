### Fixed

- **`@reticlehq/server` — a wrong guess no longer becomes a regression flow that is red forever.** A step is recorded when it is sent, before its verdict, so when an agent claimed a consequence that did not happen, that false claim was saved into the flow later cut from the session and failed every replay after. The claim now comes off the recorded step once the verdict is no; the failure is kept as a capsule, which is where "this should hold and does not" belongs.
