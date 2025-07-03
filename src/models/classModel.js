// src/models/classModel.js
import { createBaseModel } from './baseModel.js';
import pool from '../config/database.js';

export const createClassModel = () => {
    const baseModel = createBaseModel('classes');

    // Get detailed class information
    const getClassDetails = async (classId) => {
        const query = {
            text: `
                SELECT 
                    c.*,
                    t.first_name || ' ' || t.last_name as class_teacher_name,
                    t.email as class_teacher_email,
                    t.phone_primary as class_teacher_phone,
                    ac.year as academic_year,
                    ac.term as current_term,
                    COUNT(s.id) as total_students,
                    COUNT(CASE WHEN s.gender = 'male' THEN 1 END) as male_students,
                    COUNT(CASE WHEN s.gender = 'female' THEN 1 END) as female_students
                FROM classes c
                LEFT JOIN teachers t ON c.class_teacher_id = t.id
                LEFT JOIN academic_sessions ac ON c.academic_session_id = ac.id
                LEFT JOIN students s ON s.current_class = c.id
                WHERE c.id = $1
                GROUP BY c.id, t.id, ac.id
            `,
            values: [classId]
        };
        return pool.query(query);
    };

    // Get students in a class with pagination
    const getClassStudents = async (classId, page = 1, limit = 10) => {
        const offset = (page - 1) * limit;
        const query = {
            text: `
                SELECT 
                    s.*,
                    u.email,
                    p.first_name || ' ' || p.last_name as parent_name,
                    p.phone_primary as parent_phone
                FROM students s
                LEFT JOIN users u ON s.user_id = u.id
                LEFT JOIN student_parent_relationships spr ON s.id = spr.student_id
                LEFT JOIN parents p ON spr.parent_id = p.id
                WHERE s.current_class = $1
                ORDER BY s.admission_number
                LIMIT $2 OFFSET $3
            `,
            values: [classId, limit, offset]
        };
        return pool.query(query);
    };

    // Get class timetable
    const getClassTimetable = async (classId) => {
        const query = {
            text: `
                SELECT 
                    t.*,
                    s.name as subject_name,
                    s.code as subject_code,
                    tea.first_name || ' ' || tea.last_name as teacher_name
                FROM timetable t
                JOIN subjects s ON t.subject_id = s.id
                JOIN teachers tea ON t.teacher_id = tea.id
                WHERE t.class_id = $1
                ORDER BY t.day_of_week, t.start_time
            `,
            values: [classId]
        };
        return pool.query(query);
    };

    // Get attendance summary for a specific date
    const getAttendanceSummary = async (classId, date) => {
        const query = {
            text: `
                SELECT 
                    COUNT(*) as total_students,
                    COUNT(CASE WHEN a.status = 'present' THEN 1 END) as present,
                    COUNT(CASE WHEN a.status = 'absent' THEN 1 END) as absent,
                    COUNT(CASE WHEN a.status = 'late' THEN 1 END) as late,
                    COUNT(CASE WHEN a.status = 'on-leave' THEN 1 END) as on_leave
                FROM students s
                LEFT JOIN attendance a ON s.id = a.student_id 
                    AND a.date = $2
                WHERE s.current_class = $1
            `,
            values: [classId, date]
        };
        return pool.query(query);
    };

    // Assign subjects to class
    const assignSubjects = async (classId, subjectIds) => {
        const query = {
            text: `
                INSERT INTO class_subjects (class_id, subject_id)
                SELECT $1, unnest($2::int[])
                ON CONFLICT (class_id, subject_id) DO NOTHING
                RETURNING *
            `,
            values: [classId, subjectIds]
        };
        return pool.query(query);
    };

    // Get class subjects with teachers
    const getClassSubjects = async (classId) => {
        const query = {
            text: `
                SELECT 
                    s.*,
                    t.first_name || ' ' || t.last_name as teacher_name,
                    t.email as teacher_email
                FROM class_subjects cs
                JOIN subjects s ON cs.subject_id = s.id
                LEFT JOIN timetable tt ON cs.class_id = tt.class_id 
                    AND cs.subject_id = tt.subject_id
                LEFT JOIN teachers t ON tt.teacher_id = t.id
                WHERE cs.class_id = $1
                ORDER BY s.name
            `,
            values: [classId]
        };
        return pool.query(query);
    };

    // Get class exam results summary
    const getExamResults = async (classId, examTypeId) => {
        const query = {
            text: `
                SELECT 
                    s.name as subject_name,
                    ROUND(AVG(ar.marks_obtained), 2) as average_marks,
                    COUNT(ar.id) as total_students,
                    COUNT(CASE WHEN ar.grade = 'A' THEN 1 END) as a_grade,
                    COUNT(CASE WHEN ar.grade = 'B' THEN 1 END) as b_grade,
                    COUNT(CASE WHEN ar.grade = 'C' THEN 1 END) as c_grade,
                    COUNT(CASE WHEN ar.grade = 'D' THEN 1 END) as d_grade,
                    COUNT(CASE WHEN ar.grade = 'E' THEN 1 END) as e_grade
                FROM academic_records ar
                JOIN examinations e ON ar.examination_id = e.id
                JOIN subjects s ON e.subject_id = s.id
                WHERE e.class_id = $1 AND e.exam_type_id = $2
                GROUP BY s.id, s.name
                ORDER BY s.name
            `,
            values: [classId, examTypeId]
        };
        return pool.query(query);
    };

    // Get class fee defaulters
    const getFeeDefaulters = async (classId, academicSessionId) => {
        const query = {
            text: `
                WITH fee_summary AS (
                    SELECT 
                        s.id as student_id,
                        s.admission_number,
                        s.first_name || ' ' || s.last_name as student_name,
                        fs.total_amount as fee_amount,
                        COALESCE(SUM(fp.amount), 0) as paid_amount
                    FROM students s
                    JOIN fee_structure fs ON fs.class_id = s.current_class
                    LEFT JOIN fee_payments fp ON fp.student_id = s.id 
                        AND fp.academic_session_id = fs.academic_session_id
                    WHERE s.current_class = $1 
                        AND fs.academic_session_id = $2
                    GROUP BY s.id, fs.total_amount
                )
                SELECT 
                    *,
                    fee_amount - paid_amount as balance
                FROM fee_summary
                WHERE paid_amount < fee_amount
                ORDER BY balance DESC
            `,
            values: [classId, academicSessionId]
        };
        return pool.query(query);
    };

    // Assign class teacher
    const assignClassTeacher = async (classId, teacherId) => {
        return baseModel.update(classId, { class_teacher_id: teacherId });
    };

    // Get class performance trend
    const getPerformanceTrend = async (classId, academicSessionId) => {
        const query = {
            text: `
                SELECT 
                    et.name as exam_name,
                    ROUND(AVG(ar.marks_obtained), 2) as average_marks,
                    MIN(ar.marks_obtained) as minimum_marks,
                    MAX(ar.marks_obtained) as maximum_marks
                FROM academic_records ar
                JOIN examinations e ON ar.examination_id = e.id
                JOIN exam_types et ON e.exam_type_id = et.id
                WHERE e.class_id = $1 
                    AND e.academic_session_id = $2
                GROUP BY et.id, et.name
                ORDER BY et.id
            `,
            values: [classId, academicSessionId]
        };
        return pool.query(query);
    };

    // Return all model functions
    return {
        ...baseModel,
        getClassDetails,
        getClassStudents,
        getClassTimetable,
        getAttendanceSummary,
        assignSubjects,
        getClassSubjects,
        getExamResults,
        getFeeDefaulters,
        assignClassTeacher,
        getPerformanceTrend
    };
};