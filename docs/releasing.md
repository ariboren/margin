# Releasing

Publishing a GitHub release publishes `margin-md` to npm. The [release workflow](../.github/workflows/release.yml) checks that the tag matches the `package.json` version, runs the same checks as CI, packs the tarball, and publishes it through npm trusted publishing, with provenance. No npm token is stored in the repo.

## One-time setup (owner)

Do these in order. Trusted publishing needs the package to exist on npm, and provenance needs a public repo, so a release cut before step 3 fails at the publish step.

1. **Publish 0.0.0 by hand.** This creates the package on npm so trust can be set up. It is a placeholder, not a release, and has no provenance. From a clean checkout of `main`:

    ```sh
    npm login
    npm publish --otp=<code>
    ```

    npm requires two-factor authentication to publish, so turn it on for your account first and pass the current code. `prepack` builds the client first, so Bun must be installed.

2. **Trust the workflow.** On npmjs.com, open the package settings, add a trusted publisher for GitHub Actions with repository `ariboren/margin`, workflow `release.yml` and environment `npm`. Or from the CLI (npm 11.10 or later, with 2FA on your account):

    ```sh
    npm trust github margin-md --repo ariboren/margin --file release.yml --env npm
    ```

    Then set publishing access to "Require two-factor authentication and disallow tokens", so only the workflow, or you with 2FA, can publish.

3. **Make the repo public.**

4. **Protect the `npm` environment.** GitHub creates it on the first release run; you can also create it first under Settings → Environments. Add required reviewers or a tag rule if you want a gate before each publish.

## Cutting a release

1. Bump the version, regenerate the skill and commit both. The skill ends with a stamp naming the version, so `bun skill/generate.ts --check` fails in CI until it is regenerated:

    ```sh
    npm version 0.1.0 --no-git-tag-version
    bun run skill
    git commit -am "Release 0.1.0"
    git push
    ```

2. Create the release from that commit. The tag must be `v` plus the exact version:

    ```sh
    gh release create v0.1.0 --generate-notes
    ```

3. Watch the Release workflow in the Actions tab. If the tag and version differ, or any check fails, nothing is published.

A version with a prerelease part, such as `0.2.0-beta.1`, publishes under the `next` dist-tag instead of `latest`.

The [Homebrew tap](https://github.com/ariboren/homebrew-tap) picks up each new `latest` release by itself: a daily workflow there updates the formula once the npm version and its tag both exist.

## Sources

- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers): npm 11.5.1 or later, `id-token: write`, provenance is automatic.
- [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust): the package must already exist.
- [npm/cli#8544](https://github.com/npm/cli/issues/8544): no OIDC publish for a package's first version.
- [`bun publish`](https://bun.com/docs/pm/cli/publish): token auth only, so the workflow publishes with npm.
