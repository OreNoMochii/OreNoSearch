/**
 * email_address.ts — recipient parsing and validation.
 *
 * Extracted from EmailService so the security-critical parsing can be tested
 * without constructing a Gmail client or reading credential files.
 */

/**
 * Conservative RFC 5322 addr-spec check.
 *
 * Deliberately rejects the characters that carry meaning inside a header
 * (whitespace, angle brackets, quotes, comma, semicolon, colon, backslash)
 * rather than attempting the full grammar. This is an outbound allowlist,
 * not a parser.
 */
export const ADDRESS_RE = /^[^\s@<>",;:\\]+@[^\s@<>",;:\\]+\.[^\s@<>",;:\\]{2,}$/;

export class InvalidRecipientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRecipientError';
  }
}

/**
 * Splits, trims and validates a comma-separated address list.
 *
 * B3: the raw value is rejected outright if it contains CR or LF. Recipients
 * arrive from the request body and are spliced into RFC-822 headers, so a
 * newline would let an attacker inject arbitrary headers (Bcc, Reply-To) or
 * terminate the header block and forge a message body.
 *
 * @throws InvalidRecipientError on a line break or any malformed address.
 */
export function parseAddressList(raw: string | undefined, field: string): string[] {
  if (!raw) return [];

  if (/[\r\n]/.test(raw)) {
    throw new InvalidRecipientError(
      `${field} contains a line break — refusing to construct headers`,
    );
  }

  const addresses = raw
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);

  const invalid = addresses.filter((a) => !ADDRESS_RE.test(a));
  if (invalid.length > 0) {
    throw new InvalidRecipientError(`${field} contains ${invalid.length} invalid address(es)`);
  }

  return addresses;
}
