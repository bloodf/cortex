# Contributing

Keep source separate from deployment state. Use synthetic examples and a disposable server; never develop installer changes against a live homelab. Review [SECURITY.md](SECURITY.md) before submitting a patch.

## Development

Use Node 22 or newer and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
NODE_OPTIONS=--max-old-space-size=8192 pnpm build
pnpm typecheck
pnpm test
python3 installer/selfcheck.py
python3 tools/test-publication-audit.py
```

Run the repository formatter and lint configuration for touched source. Native PAM and terminal dependencies need build tools and PAM development headers. Dashboard provisioning and authentication require a real Linux/systemd environment; a successful web build does not prove them.

## Installer changes

Every selectable service must have a real recipe, dependency/port/secret contract, pinned upstream artifact provenance and verification. Never add a catalog item backed only by a placeholder, no-op or HTTP probe unrelated to the advertised function. Preserve explicit operator choices and fail before changing unrelated state.

Prove provisioning changes on a disposable fresh Ubuntu guest using the shipped commands. Test reruns, interrupted-state handling, unselected-service absence and the affected real endpoint. Verify kernel-backed restrictions through adversarial probes on the supported OS, not by searching unit text.

## Publication review

Create an exact NUL-separated list of proposed tracked paths outside the checkout, then run:

```sh
python3 tools/publication-audit.py --files /absolute/path/to/publication-files.nul
```

Review every reported location; output deliberately omits matched values. Run an independent secret scanner and manual privacy review too. False positives in synthetic fixtures still need a recorded review; do not add broad ignore rules. Inspect commit author/email metadata and ensure deployment state and credentials never enter history.

Upstream licenses and copyright notices must remain intact. Explain changed observable behavior and include reproducible verification evidence in pull requests. Do not claim untested optional integrations work.
