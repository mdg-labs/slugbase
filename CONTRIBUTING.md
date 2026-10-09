# Contributing to SlugBase

Thanks for your interest. SlugBase is in its rebuild phase; the plan is in [docs/internal/](docs/internal/) and the work is tracked as GitHub issues.

## Before you send code

- **Discuss first.** Open or comment on an issue before starting larger work, so it fits the design docs.
- **Questions** go to [GitHub Discussions](https://github.com/mdg-labs/slugbase/discussions), bugs and feature requests to the issue forms.
- **Security issues** never go into public issues: see [SECURITY.md](SECURITY.md).

## Developer Certificate of Origin (DCO)

Every commit carries a `Signed-off-by:` line, certifying the [Developer Certificate of Origin](https://developercertificate.org/). Enable the repository's hook once per clone and it adds the line for you:

```
git config core.hooksPath .githooks
```

(or commit with `git commit -s`).

## Contributor licence agreement (CLA)

SlugBase is AGPL-3.0, and MDG Labs also runs it as a hosted service. To keep that possible, outside contributions need the [contributor licence agreement](CLA.md): you keep the copyright in your contribution, and MDG Labs may also license it under other terms.

- On your first pull request, the CLA bot posts a comment asking you to sign.
- To sign, reply on the pull request with exactly: `I have read the CLA Document and I hereby sign the CLA`
- Your signature (GitHub username, time, pull request) is recorded on the `cla-signatures` branch. You sign once, for all later contributions under the same CLA version.
- Comment `recheck` if the check doesn't update.

The CLA check must pass before a pull request can be merged. The CLA is currently a draft pending legal review; until then, outside contributions aren't merged.

## Commits and pull requests

- Conventional Commits: `type(scope): imperative summary`, at most 72 characters; the body explains why.
- One change per pull request, against `dev`. `main` only moves through the maintainer's promotion pull request.
- Every user-facing string in English and German.
