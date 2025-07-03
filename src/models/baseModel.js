// src/models/BaseModel.js
import pool from '../config/database.js';

export const createBaseModel = (tableName) => {
    const findById = async (id) => {
        const query = {
            text: `SELECT * FROM ${tableName} WHERE id = $1`,
            values: [id],
        };
        return pool.query(query);
    };

    const findAll = async (page = 1, limit = 10) => {
        const offset = (page - 1) * limit;
        const query = {
            text: `SELECT * FROM ${tableName} LIMIT $1 OFFSET $2`,
            values: [limit, offset],
        };
        return pool.query(query);
    };

    const findByCondition = async (conditions) => {
        const keys = Object.keys(conditions);
        const values = Object.values(conditions);
        
        const whereClause = keys
            .map((key, index) => `${key} = $${index + 1}`)
            .join(' AND ');

        const query = {
            text: `SELECT * FROM ${tableName} WHERE ${whereClause}`,
            values: values,
        };
        return pool.query(query);
    };

    const create = async (data) => {
        const keys = Object.keys(data);
        const values = Object.values(data);
        const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
        
        const query = {
            text: `
                INSERT INTO ${tableName} (${keys.join(', ')})
                VALUES (${placeholders})
                RETURNING *
            `,
            values: values,
        };
        return pool.query(query);
    };

    const update = async (id, data) => {
        const keys = Object.keys(data);
        const values = Object.values(data);
        
        const setClause = keys
            .map((key, index) => `${key} = $${index + 1}`)
            .join(', ');

        const query = {
            text: `
                UPDATE ${tableName}
                SET ${setClause}
                WHERE id = $${keys.length + 1}
                RETURNING *
            `,
            values: [...values, id],
        };
        return pool.query(query);
    };

    const deleteById = async (id) => {
        const query = {
            text: `DELETE FROM ${tableName} WHERE id = $1 RETURNING *`,
            values: [id],
        };
        return pool.query(query);
    };

    const count = async (conditions) => {
        let query;

        if (conditions) {
            const keys = Object.keys(conditions);
            const values = Object.values(conditions);
            const whereClause = keys
                .map((key, index) => `${key} = $${index + 1}`)
                .join(' AND ');

            query = {
                text: `SELECT COUNT(*) FROM ${tableName} WHERE ${whereClause}`,
                values: values,
            };
        } else {
            query = {
                text: `SELECT COUNT(*) FROM ${tableName}`,
                values: [],
            };
        }

        const result = await pool.query(query);
        return parseInt(result.rows[0].count);
    };

    // Return all model functions
    return {
        findById,
        findAll,
        findByCondition,
        create,
        update,
        delete: deleteById, // renamed to avoid conflict with keyword
        count
    };
};
