// src/models/attendanceModel.js
import { createBaseModel } from './baseModel.js';
import pool from '../config/database.js';

export const createAttendanceModel = () => {
    const baseModel = createBaseModel('attendance');

    // Mark attendance for multiple students
    const markBulkAttendance = async (attendanceRecords) => {
        const values = attendanceRecords.map(record => `(
            ${record.student_id},
            ${record.class_id},
            ${record.academic_session_id},
            '${record.date}',
            '${record.session_type}',
            '${record.status}',
            ${record.late_minutes || 'NULL'},
            ${record.reason ? `'${record.reason}'` : 'NULL'},
            ${record.recorded_by}
        )`).join(',');

        const query = {
            text: `
                INSERT INTO attendance (
                    student_id,
                    class_id,
                    academic_session_id,
                    date,
                    session_type,
                    status,
                    late_minutes,
                    reason,
                    recorded_by
                )
                VALUES ${values}
                ON CONFLICT (student_id, academic_session_id, date, session_type)
                DO UPDATE SET
                    status = EXCLUDED.status,
                    late_minutes = EXCLUDED.late_minutes,
                    reason = EXCLUDED.reason,
                    modified_by = EXCLUDED.recorded_by,
                    modified_at = CURRENT_TIMESTAMP
                RETURNING *
            `
        };
        return pool.query(query);
    };

    // Get class attendance for a specific date
    const getClassAttendance = async (classId, date) => {
        const query = {
            text: `
                SELECT 
                    a.*,
                    s.admission_number,
                    s.first_name,
                    s.last_name,
                    u.first_name || ' ' || u.last_name as recorded_by_name
                FROM attendance a
                JOIN students s ON a.student_id = s.id
                JOIN users u ON a.recorded_by = u.id
                WHERE a.class_id = $1 
                AND a.date = $2
                ORDER BY s.admission_number, a.session_type
            `,
            values: [classId, date]
        };
        return pool.query(query);
    };

    // Get monthly attendance summary for a student
    const getStudentMonthlyAttendance = async (studentId, year, month) => {
        const query = {
            text: `
                SELECT 
                    date,
                    string_agg(
                        session_type || ': ' || status,
                        ', ' ORDER BY session_type
                    ) as daily_status,
                    bool_or(status = 'late') as was_late,
                    MAX(late_minutes) as max_late_minutes,
                    string_agg(DISTINCT reason, '; ') as reasons
                FROM attendance
                WHERE student_id = $1
                AND EXTRACT(YEAR FROM date) = $2
                AND EXTRACT(MONTH FROM date) = $3
                GROUP BY date
                ORDER BY date
            `,
            values: [studentId, year, month]
        };
        return pool.query(query);
    };

    // Get attendance statistics for a class
    const getClassAttendanceStats = async (classId, startDate, endDate) => {
        const query = {
            text: `
                WITH daily_stats AS (
                    SELECT 
                        date,
                        COUNT(*) as total_records,
                        COUNT(CASE WHEN status = 'present' THEN 1 END) as present_count,
                        COUNT(CASE WHEN status = 'absent' THEN 1 END) as absent_count,
                        COUNT(CASE WHEN status = 'late' THEN 1 END) as late_count,
                        COUNT(CASE WHEN status = 'on-leave' THEN 1 END) as leave_count
                    FROM attendance
                    WHERE class_id = $1
                    AND date BETWEEN $2 AND $3
                    GROUP BY date
                )
                SELECT 
                    COUNT(DISTINCT date) as total_days,
                    ROUND(AVG(present_count * 100.0 / total_records), 2) as avg_attendance_percentage,
                    ROUND(AVG(late_count * 100.0 / total_records), 2) as avg_late_percentage,
                    SUM(present_count) as total_present,
                    SUM(absent_count) as total_absent,
                    SUM(late_count) as total_late,
                    SUM(leave_count) as total_leave
                FROM daily_stats
            `,
            values: [classId, startDate, endDate]
        };
        return pool.query(query);
    };

    // Get students with attendance issues
    const getAttendanceIssues = async (classId, academicSessionId, threshold = 80) => {
        const query = {
            text: `
                WITH student_attendance AS (
                    SELECT 
                        student_id,
                        COUNT(*) as total_days,
                        COUNT(CASE WHEN status = 'present' THEN 1 END) as present_days,
                        COUNT(CASE WHEN status = 'late' THEN 1 END) as late_days
                    FROM attendance
                    WHERE class_id = $1
                    AND academic_session_id = $2
                    GROUP BY student_id
                )
                SELECT 
                    s.admission_number,
                    s.first_name,
                    s.last_name,
                    sa.total_days,
                    sa.present_days,
                    sa.late_days,
                    ROUND((sa.present_days * 100.0 / sa.total_days), 2) as attendance_percentage
                FROM student_attendance sa
                JOIN students s ON sa.student_id = s.id
                WHERE (sa.present_days * 100.0 / sa.total_days) < $3
                ORDER BY attendance_percentage
            `,
            values: [classId, academicSessionId, threshold]
        };
        return pool.query(query);
    };

    // Update attendance status with notification
    const updateAttendanceWithNotification = async (attendanceId, status, reason, userId) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Update attendance
            const updateQuery = {
                text: `
                    UPDATE attendance
                    SET 
                        status = $2,
                        reason = $3,
                        modified_by = $4,
                        modified_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                    RETURNING *
                `,
                values: [attendanceId, status, reason, userId]
            };
            const result = await client.query(updateQuery);

            // Create notification for parent
            if (result.rows[0]) {
                const notificationQuery = {
                    text: `
                        INSERT INTO notifications (
                            user_id,
                            title,
                            message,
                            notification_type
                        )
                        SELECT 
                            p.user_id,
                            'Attendance Update',
                            'Your child''s attendance status has been updated to ' || $2,
                            'attendance'
                        FROM attendance a
                        JOIN students s ON a.student_id = s.id
                        JOIN student_parent_relationships spr ON s.id = spr.student_id
                        JOIN parents p ON spr.parent_id = p.id
                        WHERE a.id = $1
                    `,
                    values: [attendanceId, status]
                };
                await client.query(notificationQuery);
            }

            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    };

    // Get consecutive absences
    const getConsecutiveAbsences = async (classId, minDays = 3) => {
        const query = {
            text: `
                WITH consecutive_absences AS (
                    SELECT 
                        student_id,
                        date,
                        LEAD(date, ${minDays - 1}) OVER (
                            PARTITION BY student_id 
                            ORDER BY date
                        ) as end_date,
                        COUNT(*) OVER (
                            PARTITION BY student_id 
                            ORDER BY date 
                            ROWS BETWEEN CURRENT ROW AND ${minDays - 1} FOLLOWING
                        ) as consecutive_days
                    FROM attendance
                    WHERE class_id = $1 
                    AND status = 'absent'
                )
                SELECT 
                    s.admission_number,
                    s.first_name,
                    s.last_name,
                    ca.date as start_date,
                    ca.end_date,
                    ca.consecutive_days
                FROM consecutive_absences ca
                JOIN students s ON ca.student_id = s.id
                WHERE ca.consecutive_days >= $2
                AND ca.end_date IS NOT NULL
                ORDER BY ca.date DESC
            `,
            values: [classId, minDays]
        };
        return pool.query(query);
    };

    // Return all model functions
    return {
        ...baseModel,
        markBulkAttendance,
        getClassAttendance,
        getStudentMonthlyAttendance,
        getClassAttendanceStats,
        getAttendanceIssues,
        updateAttendanceWithNotification,
        getConsecutiveAbsences
    };
};