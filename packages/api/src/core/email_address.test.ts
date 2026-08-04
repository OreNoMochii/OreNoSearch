import { describe, it, expect } from 'vitest';
import { parseAddressList, InvalidRecipientError, ADDRESS_RE } from './email_address';

describe('parseAddressList', () => {
  describe('B3 — SMTP header injection', () => {
    // Recipients come from the request body and are spliced into RFC-822
    // headers. A newline previously let an attacker inject headers or
    // terminate the header block entirely.
    it.each([
      ['bare LF', 'a@b.com\nBcc: victim@evil.com'],
      ['bare CR', 'a@b.com\rBcc: victim@evil.com'],
      ['CRLF', 'a@b.com\r\nBcc: victim@evil.com'],
      ['leading newline', '\na@b.com'],
      ['trailing newline', 'a@b.com\n'],
      ['header block terminator', 'a@b.com\r\n\r\nForged body'],
      ['newline mid-list', 'a@b.com,\nc@d.com'],
    ])('rejects %s', (_label, input) => {
      expect(() => parseAddressList(input, 'To')).toThrow(InvalidRecipientError);
    });

    it('names the offending field in the error', () => {
      expect(() => parseAddressList('a@b.com\nX', 'Cc')).toThrow(/^Cc contains a line break/);
    });

    it('rejects addresses containing header-significant characters', () => {
      for (const bad of [
        'a<b>@c.com',
        'a"b@c.com',
        'a;b@c.com',
        'a:b@c.com',
        'a\\b@c.com',
        'a b@c.com',
      ]) {
        expect(() => parseAddressList(bad, 'To'), bad).toThrow(InvalidRecipientError);
      }
    });
  });

  describe('validation', () => {
    it('rejects malformed addresses', () => {
      for (const bad of ['notanemail', 'no@tld', '@nolocal.com', 'no-at-sign.com', 'a@b']) {
        expect(() => parseAddressList(bad, 'To'), bad).toThrow(InvalidRecipientError);
      }
    });

    it('reports how many addresses were invalid', () => {
      expect(() => parseAddressList('ok@x.com, bad, alsobad', 'To')).toThrow(
        /contains 2 invalid address\(es\)/,
      );
    });
  });

  describe('accepted input', () => {
    it('returns an empty list for undefined or empty', () => {
      expect(parseAddressList(undefined, 'Cc')).toEqual([]);
      expect(parseAddressList('', 'Cc')).toEqual([]);
    });

    it('parses a single address', () => {
      expect(parseAddressList('alice@example.com', 'To')).toEqual(['alice@example.com']);
    });

    it('splits and trims a comma-separated list', () => {
      expect(parseAddressList(' a@x.com ,b@y.com,  c@z.co.uk ', 'To')).toEqual([
        'a@x.com',
        'b@y.com',
        'c@z.co.uk',
      ]);
    });

    it('drops empty entries from trailing or doubled commas', () => {
      expect(parseAddressList('a@x.com,,b@y.com,', 'To')).toEqual(['a@x.com', 'b@y.com']);
    });

    it('accepts plus-addressing and dotted locals', () => {
      expect(parseAddressList('first.last+tag@sub.example.com', 'To')).toEqual([
        'first.last+tag@sub.example.com',
      ]);
    });
  });

  describe('ADDRESS_RE', () => {
    it('is not vulnerable to a trivially catastrophic backtrack', () => {
      // Guard against a future rewrite introducing nested quantifiers.
      const hostile = 'a'.repeat(2000) + '@' + 'b'.repeat(2000);
      const started = Date.now();
      ADDRESS_RE.test(hostile);
      expect(Date.now() - started).toBeLessThan(200);
    });
  });
});
