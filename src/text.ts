/**
 * Make text from outside the tool safe to print: every control character, including the C1 range where some
 * terminals read escape sequences, is shown as `\xNN`, so a value can't move the cursor or erase lines.
 * @param text - Text from Hetzner, a zone file or the network
 * @returns The same text with control characters escaped
 */
export function printable(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
