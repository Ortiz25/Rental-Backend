import { createBaseModel } from './baseModel.js';
import pool from '../config/database.js';

export const createStudentModel = () => {
    const baseModel = createBaseModel('students');

    const findByAdmissionNumber = async (admissionNumber) => {
        return baseModel.findByCondition({ admission_number: admissionNumber });
    };

    const getCurrentClassStudents = async (classId) => {
        const query = {
            text: `
                SELECT s.*, u.email, u.username
                FROM students s
                JOIN users u ON s.user_id = u.id
                WHERE s.current_class = $1
            `,
            values: [classId],
        };
        return pool.query(query);
    };

    const getAttendanceReport = async (studentId, startDate, endDate) => {
        const query = {
            text: `
                SELECT 
                    a.date,
                    a.status,
                    a.session_type,
                    a.late_minutes,
                    a.reason
                FROM attendance a
                WHERE a.student_id = $1
                AND a.date BETWEEN $2 AND $3
                ORDER BY a.date, a.session_type
            `,
            values: [studentId, startDate, endDate],
        };
        return pool.query(query);
    };

    return {
        ...baseModel,
        findByAdmissionNumber,
        getCurrentClassStudents,
        getAttendanceReport
    };
};