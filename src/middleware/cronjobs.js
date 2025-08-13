import pool from '../config/database.js';
import cron from 'node-cron';

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

// Original schedules (fix syntax)

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

