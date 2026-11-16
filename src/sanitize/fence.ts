import { randomBytes } from 'node:crypto';

// Text from outside the agent (files, piped input) is embedded in prompts between an opening and
// a closing tag. Both carry a value drawn at random when the process starts, and a block ends
// only at the closing tag with that value, which the embedded text cannot know. The value is the
// same for the whole process, so repeated prompts stay byte-identical for prompt caching.
export const FENCE = randomBytes(6).toString('hex');

export const fenced = (
  tag: string,
  content: string,
  attributes: Readonly<Record<string, string>> = {},
): string => {
  const attrs = Object.entries(attributes)
    .map(([name, value]) => ` ${name}=${JSON.stringify(value)}`)
    .join('');
  return `<${tag}${attrs} fence="${FENCE}">\n${content}\n</${tag} fence="${FENCE}">`;
};
