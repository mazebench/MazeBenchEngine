# Claude Main World runtime v3

New Main World ASCII runs with coding Off or Python disable the built-in
telemetry plugin explicitly and set DISABLE_TELEMETRY=1. Claude Code 2.1.293
otherwise advertises cc-plugin-telemetry@builtin during initialization, which
correctly fails the unchanged empty-plugin boundary.

The v2 provider and all existing release installations stay unchanged. No
additional CLI versions are admitted. Automated tests were not run at the
operator's explicit request.
