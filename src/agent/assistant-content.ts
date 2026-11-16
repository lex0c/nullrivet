import { canonicalizeObject } from '../providers/canonical-json.ts';
import type { ProviderContentBlock } from '../providers/types.ts';
import type { CollectedStep } from './collect.ts';

// Rebuilds the assistant turn in emission order. Tool arguments are canonicalized so they
// serialize identically in every later request; reasoning data is kept verbatim.
//
// A turn with reasoning but no text or tool_use returns no blocks. Such a turn ends the loop,
// and once an adapter that does not replay reasoning drops the block, the message would be sent
// with empty content, which the provider APIs reject.
export const buildAssistantContent = (
  collected: Pick<CollectedStep, 'order'>,
): ProviderContentBlock[] => {
  const hasActionable = collected.order.some((b) => b.kind === 'text' || b.kind === 'tool_use');
  if (!hasActionable) return [];
  return collected.order.map((b): ProviderContentBlock => {
    if (b.kind === 'reasoning') return b.reasoning;
    if (b.kind === 'text') return { type: 'text', text: b.text };
    return {
      type: 'tool_use',
      id: b.toolUse.id,
      name: b.toolUse.name,
      input: canonicalizeObject(b.toolUse.input),
    };
  });
};
