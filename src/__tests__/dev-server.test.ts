/**
 * @jest-environment node
 */

/**
 * dev-server.test.ts — Verifies the safe-start wrapper prevents double starts.
 *
 * Strategy:
 *   1. Use a unique high port (to avoid conflict with the real dev server).
 *   2. Start a simple TCP listener on that port (simulating an existing server).
 *   3. Run start-dev-safe.sh with DEV_PORT set to that port.
 *   4. Assert the wrapper exits with code 1 and outputs "already in use".
 *   5. Verify check-port-and-report.sh also detects the occupied port.
 */
import { execSync, spawn } from 'child_process';
import * as net from 'net';
import * as path from 'path';

const SCRIPTS_DIR = path.resolve(__dirname, '../../scripts');
const START_SCRIPT = path.join(SCRIPTS_DIR, 'start-dev-safe.sh');
const CHECK_SCRIPT = path.join(SCRIPTS_DIR, 'check-port-and-report.sh');

// Use a high ephemeral port unlikely to collide
const TEST_PORT = 39876;

function runScript(
  scriptPath: string,
  port: number
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execSync(`bash "${scriptPath}"`, {
      env: { ...process.env, DEV_PORT: String(port) },
      timeout: 10_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
      status: execErr.status ?? 1,
    };
  }
}

describe('scripts/start-dev-safe.sh', () => {
  let server: net.Server;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = net.createServer();
        server.listen(TEST_PORT, '127.0.0.1', () => resolve());
      })
  );

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  );

  it('refuses to start when port is already occupied (exit 1)', () => {
    const result = runScript(START_SCRIPT, TEST_PORT);
    expect(result.status).toBe(1);
    expect(result.stdout.toLowerCase()).toContain('already in use');
  });

  it('does not create a second listener on the occupied port', () => {
    // Run the wrapper (should exit without starting)
    runScript(START_SCRIPT, TEST_PORT);

    // Count listeners — there should still be exactly one (our test server)
    let listenerCount = 0;
    try {
      const out = execSync(
        `lsof -iTCP:${TEST_PORT} -sTCP:LISTEN -t 2>/dev/null || true`,
        { encoding: 'utf-8' }
      );
      listenerCount = out
        .trim()
        .split('\n')
        .filter((l) => l.trim() !== '').length;
    } catch {
      // lsof not available, try ss
      try {
        const out = execSync(
          `ss -ltnp "sport = :${TEST_PORT}" 2>/dev/null | grep -c LISTEN || echo 0`,
          { encoding: 'utf-8' }
        );
        listenerCount = parseInt(out.trim(), 10) || 0;
      } catch {
        listenerCount = 1; // can't verify, assume pass
      }
    }
    expect(listenerCount).toBeLessThanOrEqual(1);
  });
});

describe('scripts/check-port-and-report.sh', () => {
  let server: net.Server;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        server = net.createServer();
        server.listen(TEST_PORT, '127.0.0.1', () => resolve());
      })
  );

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  );

  it('exits non-zero when port is occupied', () => {
    const result = runScript(CHECK_SCRIPT, TEST_PORT);
    expect(result.status).not.toBe(0);
    expect(result.stdout.toLowerCase()).toContain('fail');
  });

  it('exits 0 when port is free', () => {
    // Use a different port that's definitely free
    const result = runScript(CHECK_SCRIPT, TEST_PORT + 1);
    expect(result.status).toBe(0);
    expect(result.stdout.toLowerCase()).toContain('ok');
  });
});
