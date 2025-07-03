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

cron.schedule('0 1 * * *', async () => {
    try {
        await pool.query('SELECT restore_student_status_after_disciplinary_period()');
        console.log('Student status restoration process completed');
    } catch (err) {
        console.error('Error in status restoration:', err);
    }
});

cron.schedule('0 0 * * *', async () => {
    try {
        await pool.query('SELECT restore_teacher_status_after_leave()');
        console.log('Teacher Leave status restoration process completed');
    } catch (err) {
        console.error('Error in Leave status restoration:', err);
    }
});

cron.schedule('0 */12 * * *', async () => {
    try {
        await pool.query('SELECT restore_teacher_status_after_leave()');
        console.log('Teacher Leave status restoration process completed');
    } catch (err) {
        console.error('Error in Leave status restoration:', err);
    }
});
