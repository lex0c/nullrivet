// Glyphs shared by several renderers, each with its ASCII fallback for non-UTF-8 locales.

import type { Capabilities } from '../term.ts';

// Connector under an operation chip, and the last branch of a grouped subject tree.
export const subContentConnector = (caps: Capabilities): string => (caps.unicode ? '└─ ' : '\\- ');

// Non-last branch of a grouped subject tree. The ASCII form differs from the last-branch one.
export const treeBranchConnector = (caps: Capabilities): string => (caps.unicode ? '├─ ' : '+- ');

export const ellipsisGlyph = (caps: Capabilities): string => (caps.unicode ? '…' : '...');
