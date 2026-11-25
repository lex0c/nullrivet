import { applyChanges } from '../../src/sandbox/changeset/apply.ts';
import { classify } from '../../src/sandbox/changeset/classify.ts';
import { close, openDirectory } from '../../src/sandbox/changeset/dirfd.ts';
import { readUpper } from '../../src/sandbox/changeset/snapshot.ts';
import { symlinkTargetsInside } from '../../src/sandbox/changeset/validate.ts';

// Applies an upper layer to a project and ends its own process with SIGKILL at one step of the
// change to one path, as a kill or a power loss would end it there. It exits normally only when
// that step never comes. Arguments: project, upper layer, reference time, step, path.

const [project, upper, since, at, path] = process.argv.slice(2);
if (
  project === undefined ||
  upper === undefined ||
  since === undefined ||
  at === undefined ||
  path === undefined
) {
  throw new Error('usage: apply-until-killed <project> <upper> <since> <step> <path>');
}
const root = openDirectory(project);
try {
  const snapshot = readUpper(upper);
  const changes = symlinkTargetsInside(classify(snapshot, root), snapshot, root, project);
  applyChanges(changes, {
    projectRoot: root,
    projectPath: project,
    upperPath: upper,
    since: BigInt(since),
    step: (step, change) => {
      if (step === at && change.path.join('/') === path) process.kill(process.pid, 'SIGKILL');
    },
  });
} finally {
  close(root);
}
