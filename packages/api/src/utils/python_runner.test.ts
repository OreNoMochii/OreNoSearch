import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runPython, PythonExecutionError } from './python_runner';

/**
 * B1 regression suite.
 *
 * The original implementation built a shell command string:
 *   execPromise(`echo '${JSON.stringify(urls)}' | python3 "${script}"`)
 * JSON.stringify escapes " and \ but not ', so a single quote closed the shell
 * literal and everything after it executed — remote code execution behind
 * nothing but Basic auth.
 *
 * These tests assert the property that closes it: the payload is data, never
 * a command.
 */
describe('runPython', () => {
  let dir: string;
  let echoScript: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyrunner-'));
    echoScript = path.join(dir, 'echo_stdin.py');
    fs.writeFileSync(
      echoScript,
      'import sys, json\nprint(json.dumps({"got": sys.stdin.read()}))\n',
    );
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('B1 — shell injection', () => {
    it.each([
      ['single-quote break-out', "'; touch {CANARY}; echo '"],
      ['command substitution', '$(touch {CANARY})'],
      ['backtick substitution', '`touch {CANARY}`'],
      ['statement separator', '; touch {CANARY}'],
      ['pipe', '| touch {CANARY}'],
      ['background operator', '& touch {CANARY}'],
      ['newline injection', '\ntouch {CANARY}\n'],
    ])('treats %s as inert data', async (_label, template) => {
      const canary = path.join(dir, `canary-${Math.random().toString(36).slice(2)}`);
      const payload = template.replace('{CANARY}', canary);

      const result = await runPython<{ got: string }>({
        scriptPath: echoScript,
        stdinPayload: ['https://example.com/in/ok', payload],
      });

      // The payload must arrive at Python verbatim...
      expect(result.got).toContain('touch');
      // ...and must not have been executed by a shell.
      expect(fs.existsSync(canary), 'canary file was created — shell executed the payload').toBe(
        false,
      );
    });

    it('passes argv as arguments, not as shell tokens', async () => {
      const argScript = path.join(dir, 'echo_argv.py');
      fs.writeFileSync(argScript, 'import sys, json\nprint(json.dumps({"argv": sys.argv[1:]}))\n');

      const canary = path.join(dir, 'argv-canary');
      const result = await runPython<{ argv: string[] }>({
        scriptPath: argScript,
        args: [`; touch ${canary}`, '--flag'],
      });

      expect(result.argv).toEqual([`; touch ${canary}`, '--flag']);
      expect(fs.existsSync(canary)).toBe(false);
    });
  });

  describe('contract', () => {
    it('round-trips a JSON payload', async () => {
      const payload = { urls: ['a', 'b'], nested: { n: 1 } };
      const result = await runPython<{ got: string }>({
        scriptPath: echoScript,
        stdinPayload: payload,
      });
      expect(JSON.parse(result.got)).toEqual(payload);
    });

    it('rejects with the exit code when the script fails', async () => {
      const failing = path.join(dir, 'fail.py');
      fs.writeFileSync(failing, 'import sys\nsys.stderr.write("boom\\n")\nsys.exit(3)\n');

      await expect(runPython({ scriptPath: failing })).rejects.toThrowError(PythonExecutionError);

      await expect(runPython({ scriptPath: failing })).rejects.toMatchObject({
        code: 3,
        stderr: expect.stringContaining('boom'),
      });
    });

    it('rejects when stdout is not valid JSON', async () => {
      const garbage = path.join(dir, 'garbage.py');
      fs.writeFileSync(garbage, 'print("not json")\n');
      await expect(runPython({ scriptPath: garbage })).rejects.toThrow(/invalid JSON/);
    });

    it('rejects a missing script rather than hanging', async () => {
      await expect(
        runPython({ scriptPath: path.join(dir, 'does_not_exist.py') }),
      ).rejects.toThrowError(PythonExecutionError);
    });

    it('kills a script that exceeds its timeout', async () => {
      const slow = path.join(dir, 'slow.py');
      fs.writeFileSync(slow, 'import time\ntime.sleep(30)\n');

      const started = Date.now();
      await expect(runPython({ scriptPath: slow, timeoutMs: 400 })).rejects.toThrow(/Timed out/);
      expect(Date.now() - started).toBeLessThan(5000);
    });

    it('kills a script that floods stdout', async () => {
      const flood = path.join(dir, 'flood.py');
      fs.writeFileSync(flood, 'import sys\nwhile True:\n    sys.stdout.write("x" * 8192)\n');
      await expect(
        runPython({ scriptPath: flood, maxOutputBytes: 64 * 1024, timeoutMs: 10_000 }),
      ).rejects.toThrow(/exceeded/);
    });
  });
});
