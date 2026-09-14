# Security and privacy

Cortex controls a server. Treat its installer, dashboard administration, Docker access and agent runtimes as privileged software. Install only reviewed releases on a dedicated fresh server. Do not expose management ports directly to the public internet.

## Publication boundary

This repository contains source, generic templates and synthetic examples only. Installation answers, credentials, personal agent identities, mail, chats, memories, databases, logs, backups and generated runtime configuration belong outside the checkout. Even encrypted production credentials do not belong in this repository. Never attach them to issues, pull requests, AI prompts or CI artifacts.

A clean secret scan is not proof that a repository contains no personal information. Review filenames, examples, fixture bodies, screenshots, hostnames, domain names, IP addresses, paths, author metadata and history before publication. Reused source retains its license notices, not its original Git history.

## Local secret handling

The installer stores protected files under `/etc/cortex`, outside Git. Externally issued tokens must be entered directly into protected files on the target, not pasted into an AI conversation. Generated credentials stay on the target. Failure diagnostics may contain sensitive dependency output and must remain root-readable only; inspect locally and redact before sharing.

Backups contain credentials and user data. Protect their destination and access; a local backup is not automatically encrypted or off-site. Do not upload backup archives to GitHub.

## Administration and agents

The full dashboard uses Linux PAM and privileged host operations. An administrator session is a powerful trust boundary, not a sandbox. Restrict enrollment and network access. Agent users must not join Docker, Incus or administrator groups. Filesystem, listener and service-policy checks must pass on the installed OS before treating confinement as enforced. An accepted systemd directive alone is not proof.

## Reporting vulnerabilities

Use GitHub private vulnerability reporting when enabled. Otherwise contact the repository owner privately before disclosing credentials or an exploit against a live deployment. Do not include real personal data in a reproduction; use synthetic identities and isolated targets.
