import { sandboxHost } from '../../src/sandbox/bwrap.ts';

// The sandbox tests need Bubblewrap and unprivileged user namespaces. They are skipped where
// those are missing, unless NULLRIVET_TEST_REQUIRE_SANDBOX is set, as in CI, where a sandbox that
// cannot start must fail the run instead of letting it pass unchecked.
const host = sandboxHost();
const usable =
  typeof host !== 'string' &&
  Bun.spawnSync([host.bwrap, '--unshare-all', '--unshare-user', '--ro-bind', '/', '/', 'true'])
    .exitCode === 0;

export const sandboxTestsRun = usable || process.env.NULLRIVET_TEST_REQUIRE_SANDBOX === '1';
