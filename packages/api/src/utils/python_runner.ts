/**
 * python_runner.ts — executes Python helper scripts without a shell.
 *
 * SECURITY (B1): the previous implementation built a shell command string:
 *
 *     execPromise(`echo '${JSON.stringify(urls)}' | python3 "${script}"`)
 *
 * `profile_url` values originate from the request body, and JSON.stringify
 * escapes `"` and `\` but not `'`. A single quote therefore closed the shell
 * literal and everything after it executed as a command — remote code execution
 * behind nothing but Basic auth.
 *
 * Here argv is passed as an array with `shell: false`, and the payload travels
 * over stdin. No caller-controlled string is ever parsed by a shell, so the
 * entire injection class is closed rather than filtered.
 */
import { spawn } from 'child_process';
import path from 'path';
import { config } from '../config';
import { logWarn } from './logger';

export class PythonExecutionError extends Error {
    constructor(
        message: string,
        readonly code: number | null,
        readonly stderr: string,
    ) {
        super(message);
        this.name = 'PythonExecutionError';
    }
}

export interface RunPythonOptions {
    /** Absolute path to the script to execute. */
    scriptPath: string;
    /** Arguments after the script path. Passed as argv, never shell-expanded. */
    args?: readonly string[];
    /** JSON-serialisable value written to the child's stdin. */
    stdinPayload?: unknown;
    timeoutMs?: number;
    /** Guards against a runaway child exhausting memory. */
    maxOutputBytes?: number;
}

export async function runPython<T>(opts: RunPythonOptions): Promise<T> {
    const {
        scriptPath,
        args = [],
        stdinPayload,
        timeoutMs = config.PYTHON_TIMEOUT_MS,
        maxOutputBytes = 64 * 1024 * 1024,
    } = opts;

    return new Promise<T>((resolve, reject) => {
        const child = spawn('python3', [scriptPath, ...args], {
            shell: false, // the flag that closes the injection vector
            env: { ...process.env, PYTHONPATH: path.dirname(scriptPath) },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let settled = false;

        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
        };

        const timer = setTimeout(() => {
            finish(() => {
                child.kill('SIGKILL');
                reject(new PythonExecutionError(`Timed out after ${timeoutMs}ms`, null, ''));
            });
        }, timeoutMs);

        child.stdout.on('data', (chunk: Buffer) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > maxOutputBytes) {
                finish(() => {
                    child.kill('SIGKILL');
                    reject(
                        new PythonExecutionError(
                            `stdout exceeded ${maxOutputBytes} bytes`,
                            null,
                            '',
                        ),
                    );
                });
                return;
            }
            stdoutChunks.push(chunk);
        });

        child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

        // Writing to a child that died raises EPIPE on the stream, not the process.
        child.stdin.on('error', () => {
            /* surfaced via the close handler below */
        });

        child.on('error', (err) => {
            finish(() => reject(new PythonExecutionError(err.message, null, '')));
        });

        child.on('close', (code) => {
            finish(() => {
                const stderr = Buffer.concat(stderrChunks).toString('utf8');
                if (stderr.trim()) {
                    logWarn('python_stderr', {
                        script: path.basename(scriptPath),
                        stderr: stderr.slice(0, 2000),
                    });
                }
                if (code !== 0) {
                    reject(
                        new PythonExecutionError(
                            `${path.basename(scriptPath)} exited with code ${code}`,
                            code,
                            stderr,
                        ),
                    );
                    return;
                }
                const stdout = Buffer.concat(stdoutChunks).toString('utf8');
                try {
                    resolve(JSON.parse(stdout) as T);
                } catch (err) {
                    reject(
                        new PythonExecutionError(
                            `${path.basename(scriptPath)} produced invalid JSON: ${(err as Error).message}`,
                            code,
                            stderr,
                        ),
                    );
                }
            });
        });

        if (stdinPayload !== undefined) {
            child.stdin.write(JSON.stringify(stdinPayload));
        }
        child.stdin.end();
    });
}
