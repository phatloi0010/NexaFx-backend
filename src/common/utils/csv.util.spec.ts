import {
  FORMULA_PREFIXES,
  sanitizeCsvValue,
  escapeCsvField,
  toCsvRow,
} from './csv.util';

describe('csv.util', () => {
  describe('FORMULA_PREFIXES', () => {
    it('should include =, +, -, and @', () => {
      expect(FORMULA_PREFIXES).toEqual(['=', '+', '-', '@']);
    });
  });

  describe('sanitizeCsvValue', () => {
    it('should neutralise formula prefixes with a leading single quote', () => {
      expect(sanitizeCsvValue('=HYPERLINK("http://attacker.com")')).toBe(
        '\'=HYPERLINK("http://attacker.com")',
      );
      expect(sanitizeCsvValue('+123')).toBe("'+123");
      expect(sanitizeCsvValue('-123')).toBe("'-123");
      expect(sanitizeCsvValue('@SUM(A1:A10)')).toBe("'@SUM(A1:A10)");
    });

    it('should leave safe values unchanged', () => {
      expect(sanitizeCsvValue('normal text')).toBe('normal text');
      expect(sanitizeCsvValue('127.0.0.1')).toBe('127.0.0.1');
      expect(sanitizeCsvValue(12345)).toBe('12345');
      expect(sanitizeCsvValue('')).toBe('');
      expect(sanitizeCsvValue(null)).toBe('');
      expect(sanitizeCsvValue(undefined)).toBe('');
    });
  });

  describe('escapeCsvField', () => {
    it('should wrap values in double quotes and escape internal quotes', () => {
      expect(escapeCsvField('hello "world"')).toBe('"hello ""world"""');
    });

    it('should neutralise formulas and wrap them in quotes', () => {
      expect(escapeCsvField("=cmd|' /C calc'!'A1'")).toBe(
        "\"'=cmd|' /C calc'!'A1'\"",
      );
      expect(escapeCsvField('=HYPERLINK("http://evil.com")')).toBe(
        '"\'=HYPERLINK(""http://evil.com"")"',
      );
    });

    it('should handle null and undefined safely', () => {
      expect(escapeCsvField(null)).toBe('""');
      expect(escapeCsvField(undefined)).toBe('""');
    });
  });

  describe('toCsvRow', () => {
    it('should join values as a comma-separated escaped CSV row', () => {
      const row = toCsvRow([
        '2026-11-02 12:00:00',
        'user-1',
        '=HYPERLINK("http://evil.com")',
        'SYSTEM',
        '127.0.0.1',
      ]);
      expect(row).toBe(
        '"2026-11-02 12:00:00","user-1","\'=HYPERLINK(""http://evil.com"")","SYSTEM","127.0.0.1"',
      );
    });
  });
});
