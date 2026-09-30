### Fixed

- **`@reticlehq/server` — a wrong guess no longer becomes a regression flow that is red forever.** A step is recorded when it is sent, before its verdict, so when an agent claimed a consequence that did not happen, that false claim was saved into the flow later cut from the session and failed every replay after. The claim now comes off the recorded step once the verdict is no; the failure is kept as a capsule, which is where "this should hold and does not" belongs.
- **`@reticlehq/server` — a failed act's capsule says what was expected.** It read "declared consequence" whenever the claim was a route, element or text. It now names the claim, for example `route /settings AND element "Settings"`.

### Added

- **`@reticlehq/server` — cloud sync carries page baselines and check strengths.** How each page normally behaves and how strong each flow's checks are were kept only on the machine that measured them. They now sync with the other derived records, so the cloud can tell a page that drifted from one that always behaved that way. Needs a cloud that accepts them.
