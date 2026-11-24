import { parseBwrapVersion, sandboxHost } from '../../src/sandbox/bwrap.ts';

// The sandbox tests need Bubblewrap and unprivileged user namespaces. They are skipped where
// those are missing, unless NULLRIVET_TEST_REQUIRE_SANDBOX is set, as in CI, where a sandbox that
// cannot start must fail the run instead of letting it pass unchecked.
const host = sandboxHost();
const usable =
  typeof host !== 'string' &&
  Bun.spawnSync([host.bwrap, '--unshare-all', '--unshare-user', '--ro-bind', '/', '/', 'true'])
    .exitCode === 0;

export const sandboxTestsRun = usable || process.env.NULLRIVET_TEST_REQUIRE_SANDBOX === '1';

// The overlay options came in Bubblewrap 0.10.0. The overlay tests are skipped with an older one,
// as Ubuntu 24.04 ships, and decided by its version, not by a trial mount: on a version that has
// them, an overlay that fails is a failure.
const OVERLAY_VERSION = [0, 10, 0];
const bwrapHasOverlays = (): boolean => {
  if (typeof host === 'string') return false;
  const version = parseBwrapVersion(
    Bun.spawnSync([host.bwrap, '--version'], { env: {} }).stdout.toString(),
  );
  if (version === null) return false;
  for (const [index, wanted] of OVERLAY_VERSION.entries()) {
    const found = version[index] ?? 0;
    if (found !== wanted) return found > wanted;
  }
  return true;
};

export const overlayTestsRun = sandboxTestsRun && bwrapHasOverlays();
