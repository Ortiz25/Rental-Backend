// src/models/teacherModel.js
import { createBaseModel } from './baseModel.js';
import pool from '../config/database.js';

export const createTeacherModel = () => {
    const baseModel = createBaseModel('teachers');

    // Find teacher by staff ID
    const findByStaffId = async (staffId) => {
        return baseModel.findByCondition({ staff_id: staffId });
    };

    // Find teacher by email
    const findByEmail = async (email) => {
        return baseModel.findByCondition({ email });
    };

    // Get teacher's current classes
    const getTeacherClasses = async (teacherId) => {
        const query = {
            text: `
                SELECT 
                    c.*,
                    COUNT(s.id) as student_count
                FROM classes c
                LEFT JOIN students s ON s.current_class = c.id
                WHERE c.class_teacher_id = $1
                GROUP BY c.id
                ORDER BY c.name
            `,
            values: [teacherId]
        };
        return pool.query(query);
    };

    // Get teacher's timetable
    const getTeacherTimetable = async (teacherId) => {
        const query = {
            text: `
                SELECT 
                    t.*,
                    c.name as class_name,
                    s.name as subject_name,
                    s.code as subject_code
                FROM timetable t
                JOIN classes c ON t.class_id = c.id
                JOIN subjects s ON t.subject_id = s.id
                WHERE t.teacher_id = $1
                ORDER BY t.day_of_week, t.start_time
            `,
            values: [teacherId]
        };
        return pool.query(query);
    };

    // Get subjects taught by teacher
    const getTeacherSubjects = async (teacherId) => {
        const query = {
            text: `
                SELECT DISTINCT 
                    s.*,
                    c.name as class_name,
                    c.level as class_level
                FROM subjects s
                JOIN timetable t ON t.subject_id = s.id
                JOIN classes c ON t.class_id = c.id
                WHERE t.teacher_id = $1
                ORDER BY s.name
            `,
            values: [teacherId]
        };
        return pool.query(query);
    };

    // Get teacher's workload
    const getTeacherWorkload = async (teacherId, academicSessionId) => {
        const query = {
            text: `
                SELECT 
                    t.teacher_id,
                    COUNT(DISTINCT tt.subject_id) as total_subjects,
                    COUNT(DISTINCT tt.class_id) as total_classes,
                    COUNT(*) as total_lessons,
                    SUM(
                        EXTRACT(EPOCH FROM (tt.end_time - tt.start_time))/3600
                    ) as total_hours
                FROM teachers t
                LEFT JOIN timetable tt ON t.id = tt.teacher_id
                WHERE t.id = $1
                AND tt.academic_session_id = $2
                GROUP BY t.id
            `,
            values: [teacherId, academicSessionId]
        };
        return pool.query(query);
    };

    // Update teacher's qualifications
    const updateQualifications = async (teacherId, qualifications) => {
        return baseModel.update(teacherId, { qualification: qualifications });
    };

    // Get teacher's departments
    const getTeacherDepartments = async (teacherId) => {
        const query = {
            text: `
                SELECT DISTINCT 
                    d.*,
                    CASE 
                        WHEN d.head_teacher_id = $1 THEN true 
                        ELSE false 
                    END as is_head
                FROM departments d
                JOIN subjects s ON s.department_id = d.id
                JOIN timetable t ON t.subject_id = s.id
                WHERE t.teacher_id = $1
                ORDER BY d.name
            `,
            values: [teacherId]
        };
        return pool.query(query);
    };

    // Record teacher attendance
    const recordAttendance = async (teacherId, date, status, reason = null) => {
        const query = {
            text: `
                INSERT INTO teacher_attendance 
                    (teacher_id, date, status, reason)
                VALUES ($1, $2, $3, $4)
                RETURNING *
            `,
            values: [teacherId, date, status, reason]
        };
        return pool.query(query);
    };

    // Get teacher's attendance report
    const getAttendanceReport = async (teacherId, startDate, endDate) => {
        const query = {
            text: `
                SELECT 
                    date,
                    status,
                    reason,
                    created_at
                FROM teacher_attendance
                WHERE teacher_id = $1
                AND date BETWEEN $2 AND $3
                ORDER BY date DESC
            `,
            values: [teacherId, startDate, endDate]
        };
        return pool.query(query);
    };

    // Get teaching history
    const getTeachingHistory = async (teacherId) => {
        const query = {
            text: `
                SELECT 
                    s.name as subject_name,
                    c.name as class_name,
                    c.level as class_level,
                    ac.year,
                    ac.term
                FROM timetable t
                JOIN subjects s ON t.subject_id = s.id
                JOIN classes c ON t.class_id = c.id
                JOIN academic_sessions ac ON t.academic_session_id = ac.id
                WHERE t.teacher_id = $1
                ORDER BY ac.year DESC, ac.term DESC
            `,
            values: [teacherId]
        };
        return pool.query(query);
    };

    // Return all model functions
    return {
        ...baseModel,
        findByStaffId,
        findByEmail,
        getTeacherClasses,
        getTeacherTimetable,
        getTeacherSubjects,
        getTeacherWorkload,
        updateQualifications,
        getTeacherDepartments,
        recordAttendance,
        getAttendanceReport,
        getTeachingHistory
    };
};