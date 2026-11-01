import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

interface BackupOptions {
    sourceDbPath?: string;
    backupDir?: string;
    maxBackupsToKeep?: number;
}

export async function performOnlineBackup(options: BackupOptions = {}): Promise<{
    success: boolean;
    backupPath: string;
    backupSizeBytes: number;
    integrity: string;
    retainedCount: number;
    deletedCount: number;
}> {
    // Find project root data dir regardless of whether executing from src/ or dist/
    const projectRoot = fs.existsSync(path.resolve(__dirname, '../data/recorder.db'))
        ? path.resolve(__dirname, '..')
        : path.resolve(__dirname, '../..');

    const sourceDbPath = options.sourceDbPath || path.resolve(projectRoot, 'data/recorder.db');
    const backupDir = options.backupDir || path.resolve(projectRoot, 'data/backups');
    const maxBackupsToKeep = options.maxBackupsToKeep || 7;

    if (!fs.existsSync(sourceDbPath)) {
        throw new Error(`Source database does not exist: ${sourceDbPath}`);
    }

    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }

    const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `recorder_backup_${timestampStr}.db`;
    const destinationPath = path.join(backupDir, backupFileName);

    console.log(`[Backup] Starting online consistent SQLite backup...`);
    console.log(`  Source: ${sourceDbPath}`);
    console.log(`  Destination: ${destinationPath}`);

    // 1. Consistent Online Copy via SQLite Backup API
    // Open in readonly mode or standard mode with WAL safety
    const srcDb = new Database(sourceDbPath, { readonly: true, fileMustExist: true });
    
    try {
        await srcDb.backup(destinationPath, {
            progress({ totalPages, remainingPages }) {
                if (totalPages > 0 && remainingPages % 500 === 0) {
                    const pct = (((totalPages - remainingPages) / totalPages) * 100).toFixed(1);
                    console.log(`  Backup progress: ${pct}% (${totalPages - remainingPages}/${totalPages} pages)`);
                }
                return 100; // Copy 100 pages per step
            }
        });
        console.log(`[Backup] Online snapshot completed successfully.`);
    } finally {
        srcDb.close();
    }

    // 2. Integrity Check on the Generated Backup Copy
    console.log(`[Backup] Verifying backup database integrity via PRAGMA integrity_check...`);
    const backupDb = new Database(destinationPath, { readonly: true, fileMustExist: true });
    let integrity = 'unknown';
    try {
        const result = backupDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
        integrity = result && result.length > 0 ? result[0].integrity_check : 'FAILED';
        if (integrity !== 'ok') {
            throw new Error(`Integrity check FAILED on backup database: ${JSON.stringify(result)}`);
        }
        console.log(`[Backup] PRAGMA integrity_check PASSED: ${integrity}`);
    } finally {
        backupDb.close();
    }

    const stat = fs.statSync(destinationPath);
    console.log(`[Backup] Backup file size: ${(stat.size / (1024 * 1024)).toFixed(2)} MB`);

    // 3. Rolling Retention Policy: Keep Last 7 Backups
    console.log(`[Backup] Applying rolling retention policy (keep ${maxBackupsToKeep} most recent)...`);
    const files = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('recorder_backup_') && f.endsWith('.db'))
        .map(f => {
            const fullPath = path.join(backupDir, f);
            return {
                name: f,
                fullPath,
                mtime: fs.statSync(fullPath).mtimeMs
            };
        })
        .sort((a, b) => b.mtime - a.mtime); // Newest first

    let deletedCount = 0;
    if (files.length > maxBackupsToKeep) {
        const toDelete = files.slice(maxBackupsToKeep);
        for (const item of toDelete) {
            console.log(`  Pruning older backup: ${item.name}`);
            fs.unlinkSync(item.fullPath);
            deletedCount++;
        }
    }

    const retainedCount = files.length - deletedCount;
    console.log(`[Backup] Backup completed! Retained: ${retainedCount}, Pruned: ${deletedCount}`);

    return {
        success: true,
        backupPath: destinationPath,
        backupSizeBytes: stat.size,
        integrity,
        retainedCount,
        deletedCount
    };
}

if (require.main === module) {
    performOnlineBackup()
        .then(res => {
            console.log('\n✅ Backup Execution Result:');
            console.log(JSON.stringify(res, null, 2));
            process.exit(0);
        })
        .catch(err => {
            console.error('\n❌ Backup Failed:', err);
            process.exit(1);
        });
}
