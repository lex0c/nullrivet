import { mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { atLeast, OVERLAY_BWRAP_VERSION, sandboxHost } from '../../src/sandbox/bwrap.ts';

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
// them, an overlay that fails is a failure. NULLRIVET_TEST_REQUIRE_OVERLAY, set in CI where the
// Bubblewrap installed has them, runs them whatever the version found, so a runner that loses
// them fails instead of skipping them.
const bwrapHasOverlays = (): boolean =>
  typeof host !== 'string' && atLeast(host.version, OVERLAY_BWRAP_VERSION);

export const overlayTestsRun =
  (sandboxTestsRun && bwrapHasOverlays()) || process.env.NULLRIVET_TEST_REQUIRE_OVERLAY === '1';

// A new directory for a runtime directory of the user, which the workspace profile requires on a
// tmpfs: in /dev/shm, a tmpfs on Linux, since the temporary directory can be on disk, as in CI.
export const tmpfsDirectory = (prefix: string): string =>
  realpathSync(mkdtempSync(join('/dev/shm', prefix)));
