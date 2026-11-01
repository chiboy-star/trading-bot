import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';

describe('TypeScript vs Python Strategy Parity Suite', () => {
    it('should assert 100% signal, direction, and playbook parity between TS and Python', () => {
        const pythonPath = path.resolve(process.cwd(), 'research/.venv/Scripts/python.exe');
        const scriptPath = path.resolve(process.cwd(), 'research/parity_test.py');
        
        const output = execSync(`"${pythonPath}" "${scriptPath}"`, {
            encoding: 'utf8',
            cwd: process.cwd()
        });

        expect(output).toContain('100% PARITY CONFIRMED!');
        expect(output).toContain('Mismatches:               0');
    }, 30000);
});
