import express from 'express';
import pool from '../config/database.js';
import { authenticateToken, authorizeRole, authenticateTokenSimple } from '../middleware/auth.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';

const execAsync = promisify(exec);

const router = express.Router();

// Get all system settings
router.get('/', authenticateTokenSimple, authorizeRole(['Super Admin', 'Admin']), async (req, res) => {
  const client = await pool.connect();
  
  try {
    const settingsQuery = `
      SELECT 
        setting_key,
        setting_value,
        setting_type,
        category,
        description,
        is_public,
        is_editable,
        updated_at
      FROM system_settings
      ORDER BY category, setting_key
    `;

    const result = await client.query(settingsQuery);

    // Group settings by category
    const groupedSettings = result.rows.reduce((acc, setting) => {
      const category = setting.category || 'other';
      if (!acc[category]) {
        acc[category] = [];
      }
      acc[category].push({
        key: setting.setting_key,
        value: setting.setting_value,
        type: setting.setting_type,
        description: setting.description,
        isPublic: setting.is_public,
        isEditable: setting.is_editable,
        updatedAt: setting.updated_at
      });
      return acc;
    }, {});

    // Log activity
    await client.query(
      `INSERT INTO user_activity_log 
       (user_id, activity_type, activity_description, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.id,
        'system_settings_viewed',
        'Viewed system settings',
        req.ip,
        req.headers['user-agent']
      ]
    );

    res.status(200).json({
      status: 200,
      message: 'System settings retrieved successfully',
      data: groupedSettings
    });

  } catch (error) {
    console.error('System settings fetch error:', error);
    
    res.status(500).json({
      status: 500,
      message: 'Failed to fetch system settings',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// Update system settings (batch update)
router.put('/', authenticateTokenSimple, authorizeRole(['Super Admin', 'Admin']), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const { settings } = req.body;

    if (!settings || typeof settings !== 'object') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        status: 400,
        message: 'Settings object is required'
      });
    }

    const updatedSettings = [];
    const errors = [];

    // Process each setting update
    for (const [key, value] of Object.entries(settings)) {
      try {
        // Check if setting exists and is editable
        const checkQuery = `
          SELECT setting_key, is_editable, setting_type
          FROM system_settings
          WHERE setting_key = $1
        `;
        const checkResult = await client.query(checkQuery, [key]);

        if (checkResult.rows.length === 0) {
          errors.push({ key, error: 'Setting not found' });
          continue;
        }

        if (!checkResult.rows[0].is_editable) {
          errors.push({ key, error: 'Setting is not editable' });
          continue;
        }

        // Update the setting
        const updateQuery = `
          UPDATE system_settings
          SET setting_value = $1,
              last_modified_by = $2,
              updated_at = CURRENT_TIMESTAMP
          WHERE setting_key = $3
          RETURNING *
        `;

        const updateResult = await client.query(updateQuery, [
          String(value),
          req.user.id,
          key
        ]);

        updatedSettings.push({
          key: updateResult.rows[0].setting_key,
          value: updateResult.rows[0].setting_value
        });

        // Log individual setting change
        await client.query(
          `INSERT INTO user_activity_log 
           (user_id, activity_type, activity_description, affected_resource_type, ip_address, user_agent, additional_data)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            req.user.id,
            'system_setting_updated',
            `Updated system setting: ${key}`,
            'system_setting',
            req.ip,
            req.headers['user-agent'],
            JSON.stringify({ setting_key: key, old_value: null, new_value: value })
          ]
        );

      } catch (error) {
        errors.push({ key, error: error.message });
      }
    }

    await client.query('COMMIT');

    res.status(200).json({
      status: 200,
      message: `Successfully updated ${updatedSettings.length} settings`,
      data: {
        updated: updatedSettings,
        errors: errors.length > 0 ? errors : undefined
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('System settings update error:', error);
    
    res.status(500).json({
      status: 500,
      message: 'Failed to update system settings',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// Update single setting
router.put('/:key', authenticateTokenSimple, authorizeRole(['Super Admin', 'Admin']), async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined) {
      return res.status(400).json({
        status: 400,
        message: 'Value is required'
      });
    }

    // Check if setting exists and is editable
    const checkQuery = `
      SELECT setting_key, setting_value, is_editable, setting_type
      FROM system_settings
      WHERE setting_key = $1
    `;
    const checkResult = await client.query(checkQuery, [key]);

    if (checkResult.rows.length === 0) {
      return res.status(404).json({
        status: 404,
        message: 'Setting not found'
      });
    }

    if (!checkResult.rows[0].is_editable) {
      return res.status(403).json({
        status: 403,
        message: 'This setting cannot be modified'
      });
    }

    const oldValue = checkResult.rows[0].setting_value;

    // Update the setting
    const updateQuery = `
      UPDATE system_settings
      SET setting_value = $1,
          last_modified_by = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE setting_key = $3
      RETURNING *
    `;

    const result = await client.query(updateQuery, [
      String(value),
      req.user.id,
      key
    ]);

    // Log activity
    await client.query(
      `INSERT INTO user_activity_log 
       (user_id, activity_type, activity_description, affected_resource_type, ip_address, user_agent, additional_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.user.id,
        'system_setting_updated',
        `Updated system setting: ${key}`,
        'system_setting',
        req.ip,
        req.headers['user-agent'],
        JSON.stringify({ setting_key: key, old_value: oldValue, new_value: value })
      ]
    );

    res.status(200).json({
      status: 200,
      message: 'Setting updated successfully',
      data: {
        key: result.rows[0].setting_key,
        value: result.rows[0].setting_value,
        updatedAt: result.rows[0].updated_at
      }
    });

  } catch (error) {
    console.error('Setting update error:', error);
    
    res.status(500).json({
      status: 500,
      message: 'Failed to update setting',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// Get system statistics
router.get('/stats', authenticateTokenSimple, authorizeRole(['Super Admin', 'Admin']), async (req, res) => {
  const client = await pool.connect();
  
  try {
    const statsQuery = `
      SELECT 
        (SELECT COUNT(*) FROM properties WHERE is_active = true) as total_properties,
        (SELECT COUNT(*) FROM units WHERE is_active = true) as total_units,
        (SELECT COUNT(*) FROM tenants WHERE is_active = true) as total_tenants,
        (SELECT COUNT(*) FROM leases WHERE lease_status = 'active') as active_leases,
        (SELECT COUNT(*) FROM users WHERE is_active = true) as total_users,
        (SELECT COUNT(*) FROM maintenance_requests WHERE status IN ('open', 'in_progress')) as open_maintenance_requests,
        (SELECT pg_size_pretty(pg_database_size(current_database()))) as database_size,
        (SELECT version()) as postgres_version
    `;

    const result = await client.query(statsQuery);

    res.status(200).json({
      status: 200,
      message: 'System statistics retrieved successfully',
      data: result.rows[0]
    });

  } catch (error) {
    console.error('System stats fetch error:', error);
    
    res.status(500).json({
      status: 500,
      message: 'Failed to fetch system statistics',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// Get activity logs (recent system activity)
router.get('/activity-logs', authenticateTokenSimple, authorizeRole(['Super Admin', 'Admin']), async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { limit = 50, page = 1 } = req.query;
    const offset = (page - 1) * limit;

    const logsQuery = `
      SELECT 
        ual.id,
        ual.activity_type,
        ual.activity_description,
        ual.activity_timestamp,
        ual.ip_address,
        u.username,
        u.first_name || ' ' || u.last_name as user_full_name
      FROM user_activity_log ual
      LEFT JOIN users u ON ual.user_id = u.id
      ORDER BY ual.activity_timestamp DESC
      LIMIT $1 OFFSET $2
    `;

    const result = await client.query(logsQuery, [limit, offset]);

    const countQuery = 'SELECT COUNT(*) as total FROM user_activity_log';
    const countResult = await client.query(countQuery);

    res.status(200).json({
      status: 200,
      message: 'Activity logs retrieved successfully',
      data: {
        logs: result.rows,
        pagination: {
          currentPage: parseInt(page),
          totalRecords: parseInt(countResult.rows[0].total),
          limit: parseInt(limit)
        }
      }
    });

  } catch (error) {
    console.error('Activity logs fetch error:', error);
    
    res.status(500).json({
      status: 500,
      message: 'Failed to fetch activity logs',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// Trigger manual backup
router.post('/backup/manual', authenticateTokenSimple, authorizeRole(['Super Admin', 'Admin']), async (req, res) => {
  const client = await pool.connect();
  
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = process.env.BACKUP_DIR || './backups';
    const backupFile = path.join(backupDir, `backup_${timestamp}.sql`);
    
    // Ensure backup directory exists
    await fs.mkdir(backupDir, { recursive: true });
    
    // PostgreSQL connection details from environment
    const dbConfig = {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD
    };
    
    // Set password environment variable for pg_dump
    const env = { ...process.env, PGPASSWORD: dbConfig.password };
    
    // Execute pg_dump
    const dumpCommand = `pg_dump -h ${dbConfig.host} -p ${dbConfig.port} -U ${dbConfig.user} -d ${dbConfig.database} -F c -f "${backupFile}"`;
    
    await execAsync(dumpCommand, { env });
    
    // Get file size
    const stats = await fs.stat(backupFile);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    
    // Update last backup time in system settings
    await client.query(
      `INSERT INTO system_settings (setting_key, setting_value, setting_type, category, description)
       VALUES ('last_backup_date', $1, 'string', 'backup', 'Last backup timestamp')
       ON CONFLICT (setting_key) 
       DO UPDATE SET setting_value = $1, updated_at = CURRENT_TIMESTAMP`,
      [new Date().toISOString()]
    );
    
    // Log activity
    await client.query(
      `INSERT INTO user_activity_log 
       (user_id, activity_type, activity_description, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.id,
        'database_backup',
        `Manual database backup created: ${backupFile} (${fileSizeMB} MB)`,
        req.ip,
        req.headers['user-agent']
      ]
    );
    
    res.status(200).json({
      status: 200,
      message: 'Backup created successfully',
      data: {
        filename: path.basename(backupFile),
        size: `${fileSizeMB} MB`,
        timestamp: timestamp,
        path: backupFile
      }
    });
    
  } catch (error) {
    console.error('Backup error:', error);
    
    res.status(500).json({
      status: 500,
      message: 'Backup failed',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  } finally {
    client.release();
  }
});

// List available backups
router.get('/backup/list', authenticateTokenSimple, authorizeRole(['Super Admin', 'Admin']), async (req, res) => {
  try {
    const backupDir = process.env.BACKUP_DIR || './backups';
    
    // Check if directory exists
    try {
      await fs.access(backupDir);
    } catch {
      return res.status(200).json({
        status: 200,
        message: 'No backups found',
        data: []
      });
    }
    
    const files = await fs.readdir(backupDir);
    const backupFiles = files.filter(f => f.endsWith('.sql'));
    
    const backups = await Promise.all(
      backupFiles.map(async (file) => {
        const filePath = path.join(backupDir, file);
        const stats = await fs.stat(filePath);
        
        return {
          filename: file,
          size: `${(stats.size / (1024 * 1024)).toFixed(2)} MB`,
          created: stats.birthtime,
          path: filePath
        };
      })
    );
    
    // Sort by creation date, newest first
    backups.sort((a, b) => new Date(b.created) - new Date(a.created));
    
    res.status(200).json({
      status: 200,
      message: 'Backups retrieved successfully',
      data: backups
    });
    
  } catch (error) {
    console.error('List backups error:', error);
    
    res.status(500).json({
      status: 500,
      message: 'Failed to list backups',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Delete old backups (retention policy)
router.delete('/backup/:filename', authenticateTokenSimple, authorizeRole(['Super Admin', 'Admin']), async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { filename } = req.params;
    const backupDir = process.env.BACKUP_DIR || './backups';
    const filePath = path.join(backupDir, filename);
    
    // Security: ensure filename doesn't contain path traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({
        status: 400,
        message: 'Invalid filename'
      });
    }
    
    await fs.unlink(filePath);
    
    // Log activity
    await client.query(
      `INSERT INTO user_activity_log 
       (user_id, activity_type, activity_description, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        req.user.id,
        'database_backup_deleted',
        `Deleted backup: ${filename}`,
        req.ip,
        req.headers['user-agent']
      ]
    );
    
    res.status(200).json({
      status: 200,
      message: 'Backup deleted successfully'
    });
    
  } catch (error) {
    console.error('Delete backup error:', error);
    
    res.status(500).json({
      status: 500,
      message: 'Failed to delete backup',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

export default router;