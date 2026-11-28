import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { errorMessage } from '../../errors.ts';
import { readBounded } from './files.ts';

// The guest's kernel and the modules it loads before anything else runs. The kernel is the host's
// own, found by the release the host runs, or one the operator names; it is read once, and those
// bytes are what the guest boots and what the evidence names by their hash, since a file read
// twice could change in between. The modules are the kernel's own, from the directory of its
// release.

const MAX_KERNEL_BYTES = 128 * 1024 * 1024;
const MAX_MODULE_BYTES = 64 * 1024 * 1024;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
// A release names a directory of /lib/modules: no slash, and neither `.` nor `..`.
const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,127}$/;

// What the guest needs before its init can reach its files and the host: the virtio devices on
// PCI, the 9p filesystem over virtio, the serial ports the protocol runs on, and the network
// device. A module the kernel has built in is not loaded.
export const GUEST_MODULES = ['virtio_pci', '9pnet_virtio', '9p', 'virtio_console', 'virtio_net'];

// The release a bzImage names in its setup header, by the x86 boot protocol: the signature "HdrS"
// at 0x202, a protocol of 2.00 or later at 0x206, and at 0x20E the offset, less 0x200, of a string
// that begins with the release. Null when the image is not one, or names no release a path can
// hold.
export const kernelRelease = (image: Uint8Array): string | null => {
  const bytes = Buffer.from(image.buffer, image.byteOffset, image.byteLength);
  if (bytes.length < 0x210 || bytes.toString('latin1', 0x202, 0x206) !== 'HdrS') return null;
  if (bytes.readUInt16LE(0x206) < 0x0200) return null;
  const pointer = bytes.readUInt16LE(0x20e);
  if (pointer === 0) return null;
  const start = pointer + 0x200;
  if (start >= bytes.length) return null;
  const end = bytes.indexOf(0, start);
  const text = bytes.toString(
    'latin1',
    start,
    end === -1 ? Math.min(bytes.length, start + 256) : end,
  );
  const release = text.split(' ')[0] ?? '';
  return RELEASE.test(release) ? release : null;
};

// Where distributions keep the image of a release: beside its modules (Arch, Fedora), or in /boot
// (Debian, Ubuntu).
export const hostKernelPaths = (release: string): string[] => [
  `/lib/modules/${release}/vmlinuz`,
  `/boot/vmlinuz-${release}`,
];

export interface GuestKernel {
  source: 'distribution' | 'operator';
  path: string;
  release: string;
  sha256: string;
  image: Buffer;
}

const why = (error: unknown): string =>
  (error as NodeJS.ErrnoException).code === 'EACCES'
    ? 'it is readable by root alone, as some distributions keep it: make it readable (chmod 0644), or name another kernel with --vm-kernel'
    : errorMessage(error);

const kernelAt = (path: string, source: GuestKernel['source']): GuestKernel | { error: string } => {
  let image: Buffer;
  try {
    image = readBounded(path, MAX_KERNEL_BYTES);
  } catch (error) {
    return { error: `the kernel ${path} cannot be read: ${why(error)}` };
  }
  const release = kernelRelease(image);
  if (release === null) return { error: `${path} is not an x86 kernel image (bzImage)` };
  return { source, path, release, sha256: createHash('sha256').update(image).digest('hex'), image };
};

// The host's own kernel, of the release it runs. `root` is where the host's filesystem starts, for
// tests.
export const hostKernel = (release: string, root = ''): GuestKernel | { error: string } => {
  if (!RELEASE.test(release)) return { error: `the host's release ${release} names no kernel` };
  const path = hostKernelPaths(release)
    .map((candidate) => `${root}${candidate}`)
    .find((candidate) => existsSync(candidate));
  if (path === undefined) {
    return {
      error: `the kernel of release ${release} is in none of ${hostKernelPaths(release).join(', ')}: name one with --vm-kernel`,
    };
  }
  const kernel = kernelAt(path, 'distribution');
  if ('error' in kernel) return kernel;
  if (kernel.release !== release) {
    return {
      error: `${path} is the kernel of release ${kernel.release}, not of ${release}, which the host runs`,
    };
  }
  return kernel;
};

// A kernel the operator names, whatever release it is: its modules must be installed too.
export const operatorKernel = (path: string): GuestKernel | { error: string } =>
  kernelAt(path, 'operator');

export interface GuestModule {
  name: string;
  // Relative to the release's modules directory.
  path: string;
  // The file as the distribution ships it, which the evidence names.
  sha256: string;
  // What the guest loads: decompressed when the host can; otherwise as shipped, for the kernel to
  // decompress.
  data: Buffer;
  compressed: boolean;
}

// The name a module goes by, whatever its file's compression: `-` and `_` are the same to the
// kernel.
const moduleName = (path: string): string | null => {
  const match = /([^/]+)\.ko(\.(zst|xz|gz))?$/.exec(path);
  return match === null ? null : (match[1] as string).replaceAll('-', '_');
};

// A path modules.dep may hold: relative to the release's directory, without `..`.
const validModulePath = (path: string): boolean =>
  /^[A-Za-z0-9._+/-]+\.ko(\.(zst|xz|gz))?$/.test(path) &&
  !path.startsWith('/') &&
  path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

// The modules to load for `wanted`, each after those it depends on, from modules.dep; a module
// modules.builtin lists is in the kernel already.
export const moduleOrder = (
  dep: string,
  builtin: string,
  wanted: readonly string[],
): { name: string; path: string }[] | { error: string } => {
  const depends = new Map<string, { path: string; needs: string[] }>();
  for (const line of dep.split('\n')) {
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    const paths =
      colon === -1
        ? []
        : [
            line.slice(0, colon),
            ...line
              .slice(colon + 1)
              .trim()
              .split(/\s+/),
          ].filter((path) => path !== '');
    if (paths.length === 0 || !paths.every(validModulePath)) {
      return {
        error: `modules.dep holds a line the kernel's tools do not write: ${line.slice(0, 120)}`,
      };
    }
    const [path, ...needs] = paths as [string, ...string[]];
    depends.set(moduleName(path) as string, {
      path,
      needs: needs.map((need) => moduleName(need) as string),
    });
  }
  const builtIn = new Set(
    builtin
      .split('\n')
      .map((line) => moduleName(line.trim()))
      .filter((name): name is string => name !== null),
  );
  const order: { name: string; path: string }[] = [];
  const visiting = new Set<string>();
  const add = (name: string): string | null => {
    if (builtIn.has(name) || order.some((module) => module.name === name)) return null;
    const entry = depends.get(name);
    if (entry === undefined) return `the kernel has no module ${name}, which the guest needs`;
    if (visiting.has(name)) return `the modules ${name} depends on depend on it`;
    visiting.add(name);
    for (const need of entry.needs) {
      const problem = add(need);
      if (problem !== null) return problem;
    }
    visiting.delete(name);
    order.push({ name, path: entry.path });
    return null;
  };
  for (const name of wanted) {
    const problem = add(name.replaceAll('-', '_'));
    if (problem !== null) return { error: problem };
  }
  return order;
};

// The guest's modules, of `release`, under `root` (/lib/modules on the host); `boot` is where the
// distribution may keep the kernel's configuration.
export const guestModules = (
  release: string,
  root = '/lib/modules',
  wanted: readonly string[] = GUEST_MODULES,
  boot = '/boot',
): GuestModule[] | { error: string } => {
  if (!RELEASE.test(release)) return { error: `the release ${release} names no modules` };
  const dir = `${root}/${release}`;
  let dep: string;
  let builtin: string;
  try {
    dep = readBounded(`${dir}/modules.dep`, MAX_INDEX_BYTES).toString('utf8');
    builtin = readBounded(`${dir}/modules.builtin`, MAX_INDEX_BYTES).toString('utf8');
  } catch (error) {
    return {
      error: `the modules of release ${release} cannot be read in ${dir}: ${errorMessage(error)}`,
    };
  }
  const order = moduleOrder(dep, builtin, wanted);
  if ('error' in order) return { error: `release ${release}: ${order.error}` };
  const modules: GuestModule[] = [];
  for (const { name, path } of order) {
    let file: Buffer;
    try {
      file = readBounded(`${dir}/${path}`, MAX_MODULE_BYTES);
    } catch (error) {
      return { error: `the module ${name} cannot be read: ${errorMessage(error)}` };
    }
    let data = file;
    let compressed = false;
    try {
      if (path.endsWith('.zst'))
        data = zstdDecompressSync(file, { maxOutputLength: MAX_MODULE_BYTES });
      else if (path.endsWith('.gz')) data = gunzipSync(file, { maxOutputLength: MAX_MODULE_BYTES });
      else if (path.endsWith('.xz')) compressed = true;
    } catch (error) {
      return { error: `the module ${name} cannot be decompressed: ${errorMessage(error)}` };
    }
    modules.push({
      name,
      path,
      sha256: createHash('sha256').update(file).digest('hex'),
      data,
      compressed,
    });
  }
  // The kernel decompresses what the host could not, if it was built to: its configuration, where
  // the distribution ships it, says so before the guest starts.
  if (modules.some((module) => module.compressed)) {
    const problem = decompressionProblem(release, [`${dir}/config`, `${boot}/config-${release}`]);
    if (problem !== null) return { error: problem };
  }
  return modules;
};

// Why the kernel of `release` cannot be shown to load compressed modules, by the first
// configuration of it found; null when it can. Without one, nothing tells before the guest starts,
// and its start would fail at the first module.
const decompressionProblem = (release: string, configs: readonly string[]): string | null => {
  for (const path of configs) {
    let config: string;
    try {
      config = readBounded(path, MAX_INDEX_BYTES).toString('utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return `the configuration of release ${release} cannot be read: ${errorMessage(error)}`;
    }
    return /^CONFIG_MODULE_DECOMPRESS=y$/m.test(config)
      ? null
      : `the kernel of release ${release} cannot decompress its modules, which the host cannot decompress either (xz)`;
  }
  return `no configuration of release ${release} tells whether its kernel can decompress its modules, which the host cannot (xz): looked for ${configs.join(', ')}`;
};
