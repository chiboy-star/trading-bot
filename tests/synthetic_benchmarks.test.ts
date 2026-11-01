import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';

describe('Synthetic Backtesting Engine Validation Suite', () => {
    it('passes fixed 1R random entry test (expect PF ~1.0, WR ~50%)', () => {
        const pythonPath = path.resolve(process.cwd(), 'research/.venv/Scripts/python.exe');
        const scriptPath = path.resolve(process.cwd(), 'research/synthetic_tests.py');

        const output = execSync(`"${pythonPath}" "${scriptPath}"`, {
            encoding: 'utf8',
            cwd: process.cwd(),
            timeout: 120000
        });

        expect(output).toContain('PASS: Fixed 1R Stop & Target is perfectly unbiased.');
        expect(output).toContain('ZERO-DRIFT GBM TRAILING STOP TEST RESULTS');
    }, 120000);
});
