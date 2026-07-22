/**
 * Terminal input/output helpers.
 *
 * Two rules this module exists to enforce:
 *
 *  1. `--json` is a stable contract. When it is set, stdout carries exactly one JSON
 *     document and nothing else — no banners, no progress, no confirmation prompts.
 *     Everything human goes to stderr. A script can pipe stdout into `jq` unconditionally.
 *  2. A secret is never read from argv. `readSecret` takes it from a TTY prompt with echo
 *     disabled, or from piped stdin, so it never lands in `ps` output or shell history.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stderr, stdout } from 'node:process';

export interface OutputOptions {
  json: boolean;
}

export function printJson(value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Human-facing line. Goes to stderr in `--json` mode so stdout stays pure. */
export function info(message: string, options: OutputOptions): void {
  (options.json ? stderr : stdout).write(`${message}\n`);
}

export function warn(message: string): void {
  stderr.write(`${message}\n`);
}

/**
 * Read a secret without ever putting it in argv.
 *
 * If stdin is not a TTY (piped or redirected), the whole of stdin is consumed as the
 * value — that is the scripted path. Otherwise a prompt is shown with echo disabled.
 */
export async function readSecret(promptText: string): Promise<string> {
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').trim();
  }

  stderr.write(promptText);
  const previouslyRaw = stdin.isRaw === true;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise<string>((resolve, reject) => {
    let value = '';
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        switch (char) {
          case '\n':
          case '\r':
          case '\u0004': // Ctrl-D
            cleanup();
            stderr.write('\n');
            resolve(value.trim());
            return;
          case '\u0003': // Ctrl-C
            cleanup();
            stderr.write('\n');
            reject(new Error('Aborted.'));
            return;
          case '\u007f': // Backspace
          case '\b':
            value = value.slice(0, -1);
            break;
          default:
            if (char >= ' ') value += char;
        }
      }
    };
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(previouslyRaw);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

/**
 * Ask for an explicit confirmation. Used before every destructive action.
 *
 * Returns false rather than throwing when there is no TTY and no `--yes`: an
 * unattended process must not be able to cancel a lesson by accident.
 */
export async function confirm(
  question: string,
  options: { assumeYes: boolean; requirePhrase?: string },
): Promise<boolean> {
  if (options.assumeYes) {
    stderr.write(`${question} [--yes supplied]\n`);
    return true;
  }
  if (!stdin.isTTY) {
    stderr.write(
      `${question}\nRefusing: stdin is not a terminal and --yes was not supplied.\n`,
    );
    return false;
  }

  const expected = options.requirePhrase;
  const suffix = expected ? ` Type "${expected}" to proceed: ` : ' [y/N]: ';
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    const answer = (await rl.question(`${question}${suffix}`)).trim();
    return expected ? answer === expected : /^(y|yes)$/i.test(answer);
  } finally {
    rl.close();
  }
}

/** Render a simple aligned table to a string. */
export function table(headers: string[], rows: Array<Array<string | number | null>>): string {
  const cells = rows.map((row) => row.map((c) => (c == null ? '—' : String(c))));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map((row) => (row[i] ?? '').length)),
  );
  const line = (values: string[]): string =>
    values.map((v, i) => v.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line)].join('\n');
}
