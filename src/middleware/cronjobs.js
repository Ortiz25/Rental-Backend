import pool from '../config/database.js';
import cron from 'node-cron';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';


const execAsync = promisify(exec);

// Immediate execution for testing
// console.log('Cron job file loaded - executing immediate test');
// (async () => {
//     try {
//         console.log('Running student status restoration test...');
//         await pool.query('SELECT restore_teacher_status_after_leave()');
//         console.log('Student status restoration test completed');
//     } catch (err) {
//         console.error('Error in test restoration:', err);
//     }
// })();

// // Every minute cron schedule for testing
// cron.schedule('* * * * *', async () => {
//     try {
//         console.log('Running scheduled student status restoration...');
//         await pool.query('SELECT restore_student_status_after_disciplinary_period()');
//         console.log('Student status restoration process completed');
//     } catch (err) {
//         console.error('Error in status restoration:', err);
//     }
// });



// # 1. GENERATE MONTHLY RENT PAYMENTS - 1st of each month at 2 AM
// # Creates new rent payment records for all active leases

cron.schedule('0 2 1 * *', async () => {
    try {
        await pool.query('SELECT generate_monthly_rent_payments()');
        console.log('Monthly Invoice Generated');
    } catch (err) {
        console.error('Error creating Invoices:', err);
    }
});

// # 2. UPDATE LEASE STATUSES - Daily at midnight
// # Activates leases that have reached start date, expires leases past end date

cron.schedule('0 0 * * *', async () => {
    try {
        await pool.query('SELECT update_lease_status_by_dates()');
        console.log('Leases Activated');
    } catch (err) {
        console.error('Error in Leases Activation:', err);
    }
});

// # 3. MARK OVERDUE PAYMENTS - Daily at 1 AM
// # Marks pending payments as overdue if past due date

cron.schedule('0 1 * * *', async () => {
    try {
        await pool.query('SELECT mark_overdue_payments()');
        console.log('Overdue Payments Marked');
    } catch (err) {
        console.error('Error marking Overdue Payments:', err);
    }
});

// # 4. CLEANUP EXPIRED SESSIONS - Every 6 hours
// # Deactivates expired sessions and removes very old ones

cron.schedule('0 */6 * * *', async () => {
    try {
        await pool.query('SELECT cleanup_expired_sessions()');
        console.log('Expired sessions deactivated');
    } catch (err) {
        console.error('Error deactivating sessions:', err);
    }
});

// # 5. CLEANUP ACCESS LOGS - Weekly on Sunday at 2 AM
// # Maintains document access logs, keeps only latest 1000 per document

cron.schedule('0 2 * * 0', async () => {
    try {
        await pool.query('SELECT cleanup_access_logs()');
        console.log('Document access logs maintenance completed');
    } catch (err) {
        console.error('Error in updating access Logs:', err);
    }
});

// # 6. BACKUP CRON LOG TABLE - Monthly on 1st at 3 AM
// # Archives old cron job logs to prevent table bloat

cron.schedule('0 0 * * *', async () => {
    try {
        await pool.query("DELETE FROM cron_job_log WHERE execution_time < CURRENT_DATE - INTERVAL '3 months';");
        console.log('Old Cron Logs Deleted');
    } catch (err) {
        console.error('Error in Deleting Old Logs:', err);
    }
});



cron.schedule('0 3 * * *', async () => {
    const client = await pool.connect();
    
    try {
        console.log('Starting automated database backup...');
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupDir = process.env.BACKUP_DIR || './backups';
        const backupFile = path.join(backupDir, `backup_${timestamp}.sql`);
        
        // Ensure backup directory exists
        await fs.mkdir(backupDir, { recursive: true });
        
        // PostgreSQL connection details
        const dbConfig = {
            host: process.env.DB_HOST || 'localhost',
            port: process.env.DB_PORT || 5432,
            database: process.env.DB_NAME,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD
        };
        
        // Set password environment variable for pg_dump
        const env = { ...process.env, PGPASSWORD: dbConfig.password };
        
        // Execute pg_dump (custom format, compressed)
        const dumpCommand = `pg_dump -h ${dbConfig.host} -p ${dbConfig.port} -U ${dbConfig.user} -d ${dbConfig.database} -F c -f "${backupFile}"`;
        
        await execAsync(dumpCommand, { env });
        
        // Get file size
        const stats = await fs.stat(backupFile);
        const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
        
        console.log(`Backup created successfully: ${backupFile} (${fileSizeMB} MB)`);
        
        // Update last backup time in system_settings
        await client.query(
            `INSERT INTO system_settings (setting_key, setting_value, setting_type, category, description)
             VALUES ('last_backup_date', $1, 'string', 'backup', 'Last backup timestamp')
             ON CONFLICT (setting_key) 
             DO UPDATE SET setting_value = $1, updated_at = CURRENT_TIMESTAMP`,
            [new Date().toISOString()]
        );
        
        // Apply retention policy - get retention days from settings
        const retentionResult = await client.query(
            `SELECT setting_value FROM system_settings WHERE setting_key = 'backup_retention_days'`
        );
        
        const retentionDays = parseInt(retentionResult.rows[0]?.setting_value || '30');
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
        
        // Delete old backups
        const files = await fs.readdir(backupDir);
        const backupFiles = files.filter(f => f.startsWith('backup_') && f.endsWith('.sql'));
        
        let deletedCount = 0;
        for (const file of backupFiles) {
            const filePath = path.join(backupDir, file);
            const fileStats = await fs.stat(filePath);
            
            if (fileStats.birthtime < cutoffDate) {
                await fs.unlink(filePath);
                deletedCount++;
                console.log(`Deleted old backup: ${file}`);
            }
        }
        
        // Log to cron_job_log
        await client.query(
            `INSERT INTO cron_job_log (job_name, success, records_affected, execution_details)
             VALUES ($1, $2, $3, $4)`,
            [
                'automated_database_backup',
                true,
                1,
                JSON.stringify({
                    backup_file: backupFile,
                    size_mb: fileSizeMB,
                    deleted_old_backups: deletedCount,
                    retention_days: retentionDays
                })
            ]
        );
        
        console.log(`Automated backup completed. Deleted ${deletedCount} old backup(s)`);
        
    } catch (err) {
        console.error('Error in automated backup:', err);
        
        // Log failure
        try {
            await client.query(
                `INSERT INTO cron_job_log (job_name, success, error_message)
                 VALUES ($1, $2, $3)`,
                ['automated_database_backup', false, err.message]
            );
        } catch (logErr) {
            console.error('Error logging backup failure:', logErr);
        }
    } finally {
        client.release();
    }
});

