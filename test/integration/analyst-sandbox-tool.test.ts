import { describe, expect, it } from 'vitest';
import { runAnalystSandbox } from '@plus-one/runtime';

describe('analyst sandbox tool', () => {
  it('runs Python in a fresh isolated Docker sandbox and returns a typed artifact', async () => {
    const artifact = await runAnalystSandbox({
      pythonSource: [
        'import sys',
        'rows = input_payload["rows"]',
        'print("hello stdout")',
        'print("hello stderr", file=sys.stderr)',
        'result = {"sum": sum(item["value"] for item in rows)}',
        'calculations = ["sum values"]',
        'assumptions = []',
        'interpretation = "Computed row sum."',
      ].join('\n'),
      inputPayload: { rows: [{ value: 1 }, { value: 2 }] },
    });
    expect(artifact.result).toEqual({ sum: 3 });
    expect(artifact.stdout).toContain('hello stdout');
    expect(artifact.stderr).toContain('hello stderr');
  });

  it('does not allow the sandbox filesystem to survive across runs', async () => {
    const first = await runAnalystSandbox({
      pythonSource: [
        'open("/tmp/marker.txt", "w").write("present")',
        'result = {"created": True}',
        'calculations = ["create marker"]',
        'assumptions = []',
        'interpretation = "Marker created."',
      ].join('\n'),
      inputPayload: {},
    });
    expect(first.result).toEqual({ created: true });

    const second = await runAnalystSandbox({
      pythonSource: [
        'from pathlib import Path',
        'result = {"exists": Path("/tmp/marker.txt").exists()}',
        'calculations = ["check marker"]',
        'assumptions = []',
        'interpretation = "Marker visibility checked."',
      ].join('\n'),
      inputPayload: {},
    });
    expect(second.result).toEqual({ exists: false });
  });
});
