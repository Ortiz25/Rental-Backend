import express from 'express';
import bcrypt from 'bcryptjs';
import pool from '../config/database.js';
import { authenticateToken, authorizeRole, authenticateTokenSimple} from '../middleware/auth.js';

const router = express.Router();

// USERS ROUTES
// Get all users with role information
router.get('/users',  authenticateTokenSimple, async (req, res) => {
  try {
    const { search, role, status, is_verified } = req.query;
    
    let query = `
      SELECT 
        u.id,
        u.username,
        u.email,
        u.first_name,
        u.last_name,
        u.phone,
        u.is_active,
        u.is_verified,
        u.last_login,
        u.created_at,
        u.updated_at,
        ur.role_name,
        ur.description as role_description,
        CASE 
          WHEN u.tenant_id IS NOT NULL THEN t.first_name || ' ' || t.last_name 
          ELSE NULL 
        END as linked_tenant_name,
        CASE 
          WHEN u.tenant_id IS NOT NULL THEN 
            (SELECT p.property_name || ' - Unit ' || un.unit_number 
             FROM lease_tenants lt 
             JOIN leases l ON lt.lease_id = l.id 
             JOIN units un ON l.unit_id = un.id 
             JOIN properties p ON un.property_id = p.id 
             WHERE lt.tenant_id = u.tenant_id 
             AND lt.removed_date IS NULL 
             AND l.lease_status = 'active' 
             LIMIT 1)
          ELSE NULL 
        END as current_unit,
        -- Get activity stats
        (SELECT COUNT(*) FROM user_activity_log WHERE user_id = u.id) as total_activities,
        (SELECT COUNT(*) FROM user_notifications WHERE user_id = u.id AND is_read = false) as unread_notifications
      FROM users u
      JOIN user_roles ur ON u.role_id = ur.id
      LEFT JOIN tenants t ON u.tenant_id = t.id
    `;
    
    let whereConditions = [];
    let queryParams = [];
    let paramIndex = 1;
    
    if (search) {
      whereConditions.push(`(
        u.first_name ILIKE $${paramIndex} OR 
        u.last_name ILIKE $${paramIndex} OR 
        u.username ILIKE $${paramIndex} OR
        u.email ILIKE $${paramIndex} OR
        CONCAT(u.first_name, ' ', u.last_name) ILIKE $${paramIndex}
      )`);
      queryParams.push(`%${search}%`);
      paramIndex++;
    }
    
    if (role) {
      whereConditions.push(`ur.role_name = $${paramIndex}`);
      queryParams.push(role);
      paramIndex++;
    }
    
    if (status !== undefined) {
      if (status === 'active') {
        whereConditions.push(`u.is_active = true`);
      } else if (status === 'inactive') {
        whereConditions.push(`u.is_active = false`);
      }
    }
    
    if (is_verified !== undefined) {
      whereConditions.push(`u.is_verified = $${paramIndex}`);
      queryParams.push(is_verified === 'true');
      paramIndex++;
    }
    
    if (whereConditions.length > 0) {
      query += ' WHERE ' + whereConditions.join(' AND ');
    }
    
    query += ' ORDER BY u.created_at DESC';
    
    const result = await pool.query(query, queryParams);
    
    res.json({
      success: true,
      data: result.rows,
      total: result.rows.length
    });
    
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching users',
      error: error.message
    });
  }
});

// Get single user by ID
router.get('/users/:id',  authenticateTokenSimple, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate that id is a number
    if (isNaN(parseInt(id))) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID'
      });
    }
    
    const query = `
      SELECT 
        u.id,
        u.username,
        u.email,
        u.first_name,
        u.last_name,
        u.phone,
        u.is_active,
        u.is_verified,
        u.last_login,
        u.profile_image_url,
        u.timezone,
        u.language,
        u.notification_preferences,
        u.two_factor_enabled,
        u.created_at,
        u.updated_at,
        ur.id as role_id,
        ur.role_name,
        ur.description as role_description,
        ur.permissions,
        u.tenant_id,
        CASE 
          WHEN u.tenant_id IS NOT NULL THEN t.first_name || ' ' || t.last_name 
          ELSE NULL 
        END as linked_tenant_name,
        CASE 
          WHEN u.tenant_id IS NOT NULL THEN t.email
          ELSE NULL 
        END as tenant_email
      FROM users u
      JOIN user_roles ur ON u.role_id = ur.id
      LEFT JOIN tenants t ON u.tenant_id = t.id
      WHERE u.id = $1
    `;
    
    const result = await pool.query(query, [parseInt(id)]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Don't return sensitive information
    const user = result.rows[0];
    delete user.password_hash;
    
    res.json({
      success: true,
      data: user
    });
    
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching user',
      error: error.message
    });
  }
});

// Create new user
router.post('/users', authenticateTokenSimple, async (req, res) => {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const {
        username,
        email, 
        password,
        first_name,
        last_name,
        phone,
        role_id,
        tenant_id,
        is_active = true,
        timezone = 'Africa/Nairobi',
        language = 'en',
        notification_preferences = { email: true, sms: false, push: true }
      } = req.body;
      
      // Validate required fields
      if (!username || !email || !password || !first_name || !last_name || !role_id) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields: username, email, password, first_name, last_name, role_id'
        });
      }
      
      // Validate password strength
      if (password.length < 8) {
        return res.status(400).json({
          success: false,
          message: 'Password must be at least 8 characters long'
        });
      }
      
      // Check if username already exists
      const usernameCheck = await client.query(
        'SELECT id FROM users WHERE username = $1',
        [username]
      );
      
      if (usernameCheck.rows.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Username already exists'
        });
      }
      
      // Check if email already exists
      const emailCheck = await client.query(
        'SELECT id FROM users WHERE email = $1',
        [email]
      );
      
      if (emailCheck.rows.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Email already exists'
        });
      }
      
      // Validate role exists
      const roleCheck = await client.query(
        'SELECT id, role_name FROM user_roles WHERE id = $1',
        [role_id]
      );
      
      if (roleCheck.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid role ID'
        });
      }
      
      // If tenant_id is provided, validate it exists and role is 'Tenant'
      if (tenant_id) {
        const tenantCheck = await client.query(
          'SELECT id FROM tenants WHERE id = $1',
          [tenant_id]
        );
        
        if (tenantCheck.rows.length === 0) {
          return res.status(400).json({
            success: false,
            message: 'Invalid tenant ID'
          });
        }
        
        // Check if role is 'Tenant' when tenant_id is provided
        if (roleCheck.rows[0].role_name !== 'Tenant') {
          return res.status(400).json({
            success: false,
            message: 'tenant_id can only be provided for users with Tenant role'
          });
        }
        
        // Check if tenant already has a user account
        const existingUserCheck = await client.query(
          'SELECT id FROM users WHERE tenant_id = $1',
          [tenant_id]
        );
        
        if (existingUserCheck.rows.length > 0) {
          return res.status(400).json({
            success: false,
            message: 'This tenant already has a user account'
          });
        }
      }
      
      // Hash password
      const saltRounds = 12;
      const password_hash = await bcrypt.hash(password, saltRounds);
      
      // Create user with proper defaults for login
      const result = await client.query(`
        INSERT INTO users (
          username, email, password_hash, first_name, last_name, phone,
          role_id, tenant_id, is_active, is_verified, timezone, language, 
          notification_preferences, failed_login_attempts, locked_until,
          password_reset_token, password_reset_expires, 
          email_verification_token, email_verification_expires
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
        RETURNING id, username, email, first_name, last_name, phone, is_active, 
                  is_verified, created_at, role_id, tenant_id
      `, [
        username, email, password_hash, first_name, last_name, phone,
        role_id, tenant_id, is_active, false, // is_verified starts as false
        timezone, language, JSON.stringify(notification_preferences),
        0, // failed_login_attempts starts at 0
        null, // locked_until is null
        null, // password_reset_token is null
        null, // password_reset_expires is null
        null, // email_verification_token is null
        null  // email_verification_expires is null
      ]);
      
      const newUser = result.rows[0];
      
      // Log the user creation activity
      await client.query(`
        INSERT INTO user_activity_log (
          user_id, activity_type, activity_description, ip_address
        ) VALUES ($1, $2, $3, $4)
      `, [
        newUser.id, 
        'USER_CREATED', 
        `User account created by admin`, 
        req.ip
      ]);
      
      // Create a notification for the new user
      await client.query(`
        INSERT INTO user_notifications (
          user_id, notification_type, title, message, is_urgent
        ) VALUES ($1, $2, $3, $4, $5)
      `, [
        newUser.id,
        'ACCOUNT_CREATED',
        'Welcome! Account Created',
        `Welcome ${first_name}! Your account has been created. Please contact your administrator to verify your email address.`,
        false
      ]);
      
      await client.query('COMMIT');
      
      // Get complete user data with role info
      const completeUserQuery = `
        SELECT 
          u.id, u.username, u.email, u.first_name, u.last_name, u.phone,
          u.is_active, u.is_verified, u.created_at,
          ur.role_name, ur.description as role_description
        FROM users u
        JOIN user_roles ur ON u.role_id = ur.id
        WHERE u.id = $1
      `;
      
      const completeUserResult = await pool.query(completeUserQuery, [newUser.id]);
      
      res.status(201).json({
        success: true,
        data: completeUserResult.rows[0],
        message: 'User created successfully. Email verification required before login.'
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error creating user:', error);
      res.status(500).json({
        success: false,
        message: 'Error creating user',
        error: error.message
      });
    } finally {
      client.release();
    }
  });
  
  // Update user
  router.put('/users/:id', authenticateTokenSimple, async (req, res) => {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const { id } = req.params;
      const userId = parseInt(id);
      
      if (isNaN(userId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user ID'
        });
      }
      
      const {
        username,
        email,
        first_name,
        last_name,
        phone,
        role_id,
        tenant_id,
        is_active,
        timezone,
        language,
        notification_preferences,
        password // Optional password update
      } = req.body;
      
      // Check if user exists
      const userCheck = await client.query(
        'SELECT id, username, email FROM users WHERE id = $1',
        [userId]
      );
      
      if (userCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      const currentUser = userCheck.rows[0];
      
      // Check username uniqueness (if changed)
      if (username && username !== currentUser.username) {
        const usernameCheck = await client.query(
          'SELECT id FROM users WHERE username = $1 AND id != $2',
          [username, userId]
        );
        
        if (usernameCheck.rows.length > 0) {
          return res.status(400).json({
            success: false,
            message: 'Username already exists'
          });
        }
      }
      
      // Check email uniqueness (if changed)
      if (email && email !== currentUser.email) {
        const emailCheck = await client.query(
          'SELECT id FROM users WHERE email = $1 AND id != $2',
          [email, userId]
        );
        
        if (emailCheck.rows.length > 0) {
          return res.status(400).json({
            success: false,
            message: 'Email already exists'
          });
        }
      }
      
      // Validate role if provided
      if (role_id) {
        const roleCheck = await client.query(
          'SELECT id, role_name FROM user_roles WHERE id = $1',
          [role_id]
        );
        
        if (roleCheck.rows.length === 0) {
          return res.status(400).json({
            success: false,
            message: 'Invalid role ID'
          });
        }
      }
      
      // Build update query dynamically
      let updateFields = [];
      let updateValues = [];
      let paramIndex = 1;
      
      if (username) {
        updateFields.push(`username = $${paramIndex}`);
        updateValues.push(username);
        paramIndex++;
      }
      
      if (email) {
        updateFields.push(`email = $${paramIndex}`);
        updateValues.push(email);
        paramIndex++;
      }
      
      if (first_name) {
        updateFields.push(`first_name = $${paramIndex}`);
        updateValues.push(first_name);
        paramIndex++;
      }
      
      if (last_name) {
        updateFields.push(`last_name = $${paramIndex}`);
        updateValues.push(last_name);
        paramIndex++;
      }
      
      if (phone !== undefined) {
        updateFields.push(`phone = $${paramIndex}`);
        updateValues.push(phone);
        paramIndex++;
      }
      
      if (role_id) {
        updateFields.push(`role_id = $${paramIndex}`);
        updateValues.push(role_id);
        paramIndex++;
      }
      
      if (tenant_id !== undefined) {
        updateFields.push(`tenant_id = $${paramIndex}`);
        updateValues.push(tenant_id);
        paramIndex++;
      }
      
      if (is_active !== undefined) {
        updateFields.push(`is_active = $${paramIndex}`);
        updateValues.push(is_active);
        paramIndex++;
      }
      
      if (timezone) {
        updateFields.push(`timezone = $${paramIndex}`);
        updateValues.push(timezone);
        paramIndex++;
      }
      
      if (language) {
        updateFields.push(`language = $${paramIndex}`);
        updateValues.push(language);
        paramIndex++;
      }
      
      if (notification_preferences) {
        updateFields.push(`notification_preferences = $${paramIndex}`);
        updateValues.push(JSON.stringify(notification_preferences));
        paramIndex++;
      }
      
      // Handle password update
      if (password) {
        if (password.length < 8) {
          return res.status(400).json({
            success: false,
            message: 'Password must be at least 8 characters long'
          });
        }
        
        const saltRounds = 12;
        const password_hash = await bcrypt.hash(password, saltRounds);
        updateFields.push(`password_hash = $${paramIndex}`);
        updateValues.push(password_hash);
        paramIndex++;
      }
      
      if (updateFields.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No fields to update'
        });
      }
      
      // Add updated_at timestamp
      updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
      updateValues.push(userId);
      
      const updateQuery = `
        UPDATE users 
        SET ${updateFields.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING id, username, email, first_name, last_name, phone, 
                  is_active, is_verified, updated_at
      `;
      
      const result = await client.query(updateQuery, updateValues);
      
      // Log the update activity
      await client.query(`
        INSERT INTO user_activity_log (
          user_id, activity_type, activity_description, ip_address
        ) VALUES ($1, $2, $3, $4)
      `, [
        userId, 
        'USER_UPDATED', 
        `User profile updated`, 
        req.ip
      ]);
      
      await client.query('COMMIT');
      
      // Get complete updated user data
      const completeUserQuery = `
        SELECT 
          u.id, u.username, u.email, u.first_name, u.last_name, u.phone,
          u.is_active, u.is_verified, u.updated_at,
          ur.role_name, ur.description as role_description
        FROM users u
        JOIN user_roles ur ON u.role_id = ur.id
        WHERE u.id = $1
      `;
      
      const completeUserResult = await pool.query(completeUserQuery, [userId]);
      
      res.json({
        success: true,
        data: completeUserResult.rows[0],
        message: 'User updated successfully'
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error updating user:', error);
      res.status(500).json({
        success: false,
        message: 'Error updating user',
        error: error.message
      });
    } finally {
      client.release();
    }
  });

  // Deactivate/Activate user (soft delete)
router.patch('/users/:id/status', authenticateToken,  async (req, res) => {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const { id } = req.params;
      const { is_active } = req.body;
      const userId = parseInt(id);
      
      if (isNaN(userId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user ID'
        });
      }
      
      if (is_active === undefined) {
        return res.status(400).json({
          success: false,
          message: 'is_active field is required'
        });
      }
      
      // Check if user exists
      const userCheck = await client.query(
        'SELECT id, username, is_active FROM users WHERE id = $1',
        [userId]
      );
      
      if (userCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      const currentUser = userCheck.rows[0];
      
      if (currentUser.is_active === is_active) {
        return res.status(400).json({
          success: false,
          message: `User is already ${is_active ? 'active' : 'inactive'}`
        });
      }
      
      // Update user status
      const result = await client.query(`
        UPDATE users 
        SET is_active = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING id, username, is_active, updated_at
      `, [is_active, userId]);
      
      // If deactivating user, end all active sessions
      if (!is_active) {
        await client.query(`
          UPDATE user_sessions 
          SET is_active = false, last_activity = CURRENT_TIMESTAMP
          WHERE user_id = $1 AND is_active = true
        `, [userId]);
      }
      
      // Log the status change
      await client.query(`
        INSERT INTO user_activity_log (
          user_id, activity_type, activity_description, ip_address
        ) VALUES ($1, $2, $3, $4)
      `, [
        userId, 
        is_active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', 
        `User account ${is_active ? 'activated' : 'deactivated'} by admin`, 
        req.ip
      ]);
      
      await client.query('COMMIT');
      
      res.json({
        success: true,
        data: result.rows[0],
        message: `User ${is_active ? 'activated' : 'deactivated'} successfully`
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error updating user status:', error);
      res.status(500).json({
        success: false,
        message: 'Error updating user status',
        error: error.message
      });
    } finally {
      client.release();
    }
  });
  
  // Get user roles
  router.get('/user-roles',  authenticateTokenSimple, async (req, res) => {
    try {
      const query = `
        SELECT 
          id,
          role_name,
          description,
          permissions,
          created_at,
          (SELECT COUNT(*) FROM users WHERE role_id = user_roles.id AND is_active = true) as active_users_count
        FROM user_roles 
        ORDER BY role_name
      `;
      
      const result = await pool.query(query);
      
      res.json({
        success: true,
        data: result.rows
      });
      
    } catch (error) {
      console.error('Error fetching user roles:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching user roles',
        error: error.message
      });
    }
  });
  
  // Get user activity log
  router.get('/users/:id/activity',  authenticateTokenSimple, async (req, res) => {
    try {
      const { id } = req.params;
      const { limit = 50, offset = 0 } = req.query;
      const userId = parseInt(id);
      
      if (isNaN(userId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user ID'
        });
      }
      
      const query = `
        SELECT 
          id,
          activity_type,
          activity_description,
          affected_resource_type,
          affected_resource_id,
          ip_address,
          activity_timestamp,
          additional_data
        FROM user_activity_log 
        WHERE user_id = $1
        ORDER BY activity_timestamp DESC
        LIMIT $2 OFFSET $3
      `;
      
      const result = await pool.query(query, [userId, parseInt(limit), parseInt(offset)]);
      
      // Get total count
      const countResult = await pool.query(
        'SELECT COUNT(*) as total FROM user_activity_log WHERE user_id = $1',
        [userId]
      );
      
      res.json({
        success: true,
        data: result.rows,
        total: parseInt(countResult.rows[0].total),
        limit: parseInt(limit),
        offset: parseInt(offset)
      });
      
    } catch (error) {
      console.error('Error fetching user activity:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching user activity',
        error: error.message
      });
    }
  });
  
  // Get user notifications
  router.get('/users/:id/notifications',  authenticateTokenSimple, async (req, res) => {
    try {
      const { id } = req.params;
      const { unread_only = false, limit = 20, offset = 0 } = req.query;
      const userId = parseInt(id);
      
      if (isNaN(userId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user ID'
        });
      }
      
      let query = `
        SELECT 
          id,
          notification_type,
          title,
          message,
          is_read,
          is_urgent,
          related_resource_type,
          related_resource_id,
          delivery_method,
          scheduled_for,
          sent_at,
          created_at
        FROM user_notifications 
        WHERE user_id = $1
      `;
      
      let queryParams = [userId];
      let paramIndex = 2;
      
      if (unread_only === 'true') {
        query += ` AND is_read = false`;
      }
      
      query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      queryParams.push(parseInt(limit), parseInt(offset));
      
      const result = await pool.query(query, queryParams);
      
      // Get counts
      const countQuery = `
        SELECT 
          COUNT(*) as total,
          COUNT(CASE WHEN is_read = false THEN 1 END) as unread_count
        FROM user_notifications 
        WHERE user_id = $1
      `;
      
      const countResult = await pool.query(countQuery, [userId]);
      
      res.json({
        success: true,
        data: result.rows,
        total: parseInt(countResult.rows[0].total),
        unread_count: parseInt(countResult.rows[0].unread_count),
        limit: parseInt(limit),
        offset: parseInt(offset)
      });
      
    } catch (error) {
      console.error('Error fetching user notifications:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching user notifications',
        error: error.message
      });
    }
  });
  
  // Mark notification as read
  router.patch('/users/:id/notifications/:notificationId/read',  authenticateTokenSimple, async (req, res) => {
    try {
      const { id, notificationId } = req.params;
      const userId = parseInt(id);
      const notifId = parseInt(notificationId);
      
      if (isNaN(userId) || isNaN(notifId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user ID or notification ID'
        });
      }
      
      const result = await pool.query(`
        UPDATE user_notifications 
        SET is_read = true 
        WHERE id = $1 AND user_id = $2
        RETURNING id, is_read
      `, [notifId, userId]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Notification not found'
        });
      }
      
      res.json({
        success: true,
        data: result.rows[0],
        message: 'Notification marked as read'
      });
      
    } catch (error) {
      console.error('Error marking notification as read:', error);
      res.status(500).json({
        success: false,
        message: 'Error updating notification',
        error: error.message
      });
    }
  });
  
  // Get user statistics/dashboard data
  router.get('/users/stats/dashboard',  authenticateTokenSimple, async (req, res) => {
    try {
      const query = `
        SELECT 
          (SELECT COUNT(*) FROM users WHERE is_active = true) as total_active_users,
          (SELECT COUNT(*) FROM users WHERE is_active = false) as total_inactive_users,
          (SELECT COUNT(*) FROM users WHERE is_verified = false AND is_active = true) as unverified_users,
          (SELECT COUNT(*) FROM users WHERE last_login > CURRENT_TIMESTAMP - INTERVAL '24 hours') as users_active_today,
          (SELECT COUNT(*) FROM users WHERE last_login > CURRENT_TIMESTAMP - INTERVAL '7 days') as users_active_week,
          (SELECT COUNT(*) FROM users WHERE created_at > CURRENT_TIMESTAMP - INTERVAL '30 days') as new_users_month,
          -- Role breakdown
          (SELECT 
            JSON_AGG(
              JSON_BUILD_OBJECT(
                'role_name', ur.role_name,
                'user_count', COUNT(u.id)
              )
            )
            FROM user_roles ur
            LEFT JOIN users u ON ur.id = u.role_id AND u.is_active = true
            GROUP BY ur.id, ur.role_name
          ) as role_breakdown
      `;
      
      const result = await pool.query(query);
      
      res.json({
        success: true,
        data: result.rows[0]
      });
      
    } catch (error) {
      console.error('Error fetching user statistics:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching user statistics',
        error: error.message
      });
    }
  });
  
  // Reset user password (Admin only)
  router.post('/users/:id/reset-password', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const { id } = req.params;
      const { new_password, force_change = true } = req.body;
      const userId = parseInt(id);
      
      if (isNaN(userId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user ID'
        });
      }
      
      if (!new_password) {
        return res.status(400).json({
          success: false,
          message: 'New password is required'
        });
      }
      
      if (new_password.length < 8) {
        return res.status(400).json({
          success: false,
          message: 'Password must be at least 8 characters long'
        });
      }
      
      // Check if user exists
      const userCheck = await client.query(
        'SELECT id, username FROM users WHERE id = $1',
        [userId]
      );
      
      if (userCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      // Hash new password
      const saltRounds = 12;
      const password_hash = await bcrypt.hash(new_password, saltRounds);
      
      // Update password and optionally force password change on next login
      const result = await client.query(`
        UPDATE users 
        SET password_hash = $1, 
            password_reset_token = NULL,
            password_reset_expires = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING id, username, updated_at
      `, [password_hash, userId]);
      
      // End all active sessions to force re-login
      await client.query(`
        UPDATE user_sessions 
        SET is_active = false, last_activity = CURRENT_TIMESTAMP
        WHERE user_id = $1 AND is_active = true
      `, [userId]);
      
      // Log the password reset
      await client.query(`
        INSERT INTO user_activity_log (
          user_id, activity_type, activity_description, ip_address
        ) VALUES ($1, $2, $3, $4)
      `, [
        userId, 
        'PASSWORD_RESET_ADMIN', 
        `Password reset by administrator`, 
        req.ip
      ]);
      
      await client.query('COMMIT');
      
      res.json({
        success: true,
        data: result.rows[0],
        message: 'Password reset successfully. User will need to log in again.'
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error resetting password:', error);
      res.status(500).json({
        success: false,
        message: 'Error resetting password',
        error: error.message
      });
    } finally {
      client.release();
    }
  });
  
  // Bulk operations - Activate/Deactivate multiple users
  router.patch('/users/bulk/status', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const { user_ids, is_active } = req.body;
      
      if (!Array.isArray(user_ids) || user_ids.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'user_ids must be a non-empty array'
        });
      }
      
      if (is_active === undefined) {
        return res.status(400).json({
          success: false,
          message: 'is_active field is required'
        });
      }
      
      // Validate all user IDs
      const validIds = user_ids.filter(id => !isNaN(parseInt(id))).map(id => parseInt(id));
      
      if (validIds.length !== user_ids.length) {
        return res.status(400).json({
          success: false,
          message: 'All user IDs must be valid numbers'
        });
      }
      
      // Update users
      const result = await client.query(`
        UPDATE users 
        SET is_active = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ANY($2::int[])
        RETURNING id, username, is_active
      `, [is_active, validIds]);
      
      // If deactivating, end all active sessions for these users
      if (!is_active) {
        await client.query(`
          UPDATE user_sessions 
          SET is_active = false, last_activity = CURRENT_TIMESTAMP
          WHERE user_id = ANY($1::int[]) AND is_active = true
        `, [validIds]);
      }
      
      // Log bulk operation
      for (const userId of validIds) {
        await client.query(`
          INSERT INTO user_activity_log (
            user_id, activity_type, activity_description, ip_address
          ) VALUES ($1, $2, $3, $4)
        `, [
          userId, 
          is_active ? 'USER_BULK_ACTIVATED' : 'USER_BULK_DEACTIVATED', 
          `User ${is_active ? 'activated' : 'deactivated'} via bulk operation`, 
          req.ip
        ]);
      }
      
      await client.query('COMMIT');
      
      res.json({
        success: true,
        data: result.rows,
        message: `${result.rows.length} users ${is_active ? 'activated' : 'deactivated'} successfully`
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in bulk status update:', error);
      res.status(500).json({
        success: false,
        message: 'Error updating user statuses',
        error: error.message
      });
    } finally {
      client.release();
    }
  });

  // USER ROLES MANAGEMENT

// Create new role
router.post('/user-roles', authenticateToken,  async (req, res) => {
    try {
      const { role_name, description, permissions } = req.body;
      
      if (!role_name) {
        return res.status(400).json({
          success: false,
          message: 'Role name is required'
        });
      }
      
      // Check if role name already exists
      const roleCheck = await pool.query(
        'SELECT id FROM user_roles WHERE role_name = $1',
        [role_name]
      );
      
      if (roleCheck.rows.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Role name already exists'
        });
      }
      
      const result = await pool.query(`
        INSERT INTO user_roles (role_name, description, permissions)
        VALUES ($1, $2, $3)
        RETURNING *
      `, [role_name, description, permissions ? JSON.stringify(permissions) : null]);
      
      res.status(201).json({
        success: true,
        data: result.rows[0],
        message: 'Role created successfully'
      });
      
    } catch (error) {
      console.error('Error creating role:', error);
      res.status(500).json({
        success: false,
        message: 'Error creating role',
        error: error.message
      });
    }
  });
  
  // Update role
  router.put('/user-roles/:id', authenticateToken,async (req, res) => {
    try {
      const { id } = req.params;
      const { role_name, description, permissions } = req.body;
      const roleId = parseInt(id);
      
      if (isNaN(roleId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid role ID'
        });
      }
      
      // Check if role exists
      const roleCheck = await pool.query(
        'SELECT id FROM user_roles WHERE id = $1',
        [roleId]
      );
      
      if (roleCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Role not found'
        });
      }
      
      // Check if new role name conflicts (if changed)
      if (role_name) {
        const nameCheck = await pool.query(
          'SELECT id FROM user_roles WHERE role_name = $1 AND id != $2',
          [role_name, roleId]
        );
        
        if (nameCheck.rows.length > 0) {
          return res.status(400).json({
            success: false,
            message: 'Role name already exists'
          });
        }
      }
      
      // Build update query
      let updateFields = [];
      let updateValues = [];
      let paramIndex = 1;
      
      if (role_name) {
        updateFields.push(`role_name = $${paramIndex}`);
        updateValues.push(role_name);
        paramIndex++;
      }
      
      if (description !== undefined) {
        updateFields.push(`description = $${paramIndex}`);
        updateValues.push(description);
        paramIndex++;
      }
      
      if (permissions !== undefined) {
        updateFields.push(`permissions = $${paramIndex}`);
        updateValues.push(permissions ? JSON.stringify(permissions) : null);
        paramIndex++;
      }
      
      if (updateFields.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No fields to update'
        });
      }
      
      updateValues.push(roleId);
      
      const updateQuery = `
        UPDATE user_roles 
        SET ${updateFields.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING *
      `;
      
      const result = await pool.query(updateQuery, updateValues);
      
      res.json({
        success: true,
        data: result.rows[0],
        message: 'Role updated successfully'
      });
      
    } catch (error) {
      console.error('Error updating role:', error);
      res.status(500).json({
        success: false,
        message: 'Error updating role',
        error: error.message
      });
    }
  });
  
  // Delete role (only if no users assigned)
  router.delete('/user-roles/:id', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const { id } = req.params;
      const roleId = parseInt(id);
      
      if (isNaN(roleId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid role ID'
        });
      }
      
      // Check if role exists
      const roleCheck = await client.query(
        'SELECT id, role_name FROM user_roles WHERE id = $1',
        [roleId]
      );
      
      if (roleCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Role not found'
        });
      }
      
      // Check if any users are assigned to this role
      const usersCheck = await client.query(
        'SELECT COUNT(*) as user_count FROM users WHERE role_id = $1',
        [roleId]
      );
      
      const userCount = parseInt(usersCheck.rows[0].user_count);
      
      if (userCount > 0) {
        return res.status(400).json({
          success: false,
          message: `Cannot delete role. ${userCount} user(s) are assigned to this role.`
        });
      }
      
      // Delete the role
      await client.query('DELETE FROM user_roles WHERE id = $1', [roleId]);
      
      await client.query('COMMIT');
      
      res.json({
        success: true,
        message: 'Role deleted successfully'
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error deleting role:', error);
      res.status(500).json({
        success: false,
        message: 'Error deleting role',
        error: error.message
      });
    } finally {
      client.release();
    }
  });
  
  // Get available permissions/resources
  router.get('/permissions/available',  authenticateTokenSimple, async (req, res) => {
    try {
      // Define available permissions structure
      const availablePermissions = {
        properties: {
          name: 'Properties',
          actions: ['view', 'create', 'edit', 'delete', 'manage_units']
        },
        tenants: {
          name: 'Tenants',
          actions: ['view', 'create', 'edit', 'delete', 'view_documents']
        },
        leases: {
          name: 'Leases',
          actions: ['view', 'create', 'edit', 'delete', 'manage_renewals']
        },
        payments: {
          name: 'Payments',
          actions: ['view', 'record', 'edit', 'delete', 'manage_deposits']
        },
        maintenance: {
          name: 'Maintenance',
          actions: ['view', 'create', 'edit', 'delete', 'assign_requests']
        },
        documents: {
          name: 'Documents',
          actions: ['view', 'upload', 'edit', 'delete', 'manage_categories']
        },
        reports: {
          name: 'Reports',
          actions: ['view', 'generate', 'export', 'schedule']
        },
        users: {
          name: 'User Management',
          actions: ['view', 'create', 'edit', 'delete', 'manage_roles', 'reset_passwords']
        },
        settings: {
          name: 'System Settings',
          actions: ['view', 'edit', 'backup', 'restore']
        }
      };
      
      res.json({
        success: true,
        data: availablePermissions
      });
      
    } catch (error) {
      console.error('Error fetching available permissions:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching available permissions',
        error: error.message
      });
    }
  });
  
  // Check user permission for specific resource/action
  router.get('/users/:id/permissions/check',  authenticateTokenSimple, async (req, res) => {
    try {
      const { id } = req.params;
      const { resource, action } = req.query;
      const userId = parseInt(id);
      
      if (isNaN(userId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user ID'
        });
      }
      
      if (!resource || !action) {
        return res.status(400).json({
          success: false,
          message: 'Resource and action parameters are required'
        });
      }
      
      // Use the permission checking function from the database
      const result = await pool.query(
        'SELECT check_user_permission($1, $2, $3) as has_permission',
        [userId, resource, action]
      );
      
      const hasPermission = result.rows[0].has_permission;
      
      res.json({
        success: true,
        data: {
          user_id: userId,
          resource,
          action,
          has_permission: hasPermission
        }
      });
      
    } catch (error) {
      console.error('Error checking user permission:', error);
      res.status(500).json({
        success: false,
        message: 'Error checking user permission',
        error: error.message
      });
    }
  });
  
  // Get user's full permission set
  router.get('/users/:id/permissions',  authenticateTokenSimple, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = parseInt(id);
      
      if (isNaN(userId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user ID'
        });
      }
      
      const query = `
        SELECT 
          u.id,
          u.username,
          ur.role_name,
          ur.permissions,
          u.is_active
        FROM users u
        JOIN user_roles ur ON u.role_id = ur.id
        WHERE u.id = $1
      `;
      
      const result = await pool.query(query, [userId]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      const user = result.rows[0];
      
      res.json({
        success: true,
        data: {
          user_id: user.id,
          username: user.username,
          role_name: user.role_name,
          permissions: user.permissions,
          is_active: user.is_active
        }
      });
      
    } catch (error) {
      console.error('Error fetching user permissions:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching user permissions',
        error: error.message
      });
    }
  });
  
  // TENANT-USER LINKING ROUTES
  
  // Link tenant to user account
  router.post('/users/:id/link-tenant', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const { id } = req.params;
      const { tenant_id } = req.body;
      const userId = parseInt(id);
      
      if (isNaN(userId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user ID'
        });
      }
      
      if (!tenant_id || isNaN(parseInt(tenant_id))) {
        return res.status(400).json({
          success: false,
          message: 'Valid tenant ID is required'
        });
      }
      
      const tenantId = parseInt(tenant_id);
      
      // Check if user exists and has Tenant role
      const userCheck = await client.query(`
        SELECT u.id, u.username, ur.role_name, u.tenant_id
        FROM users u
        JOIN user_roles ur ON u.role_id = ur.id
        WHERE u.id = $1
      `, [userId]);
      
      if (userCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      const user = userCheck.rows[0];
      
      if (user.role_name !== 'Tenant') {
        return res.status(400).json({
          success: false,
          message: 'User must have Tenant role to be linked to a tenant'
        });
      }
      
      if (user.tenant_id === tenantId) {
        return res.status(400).json({
          success: false,
          message: 'User is already linked to this tenant'
        });
      }
      
      // Check if tenant exists
      const tenantCheck = await client.query(
        'SELECT id, first_name, last_name, email FROM tenants WHERE id = $1',
        [tenantId]
      );
      
      if (tenantCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Tenant not found'
        });
      }
      
      // Check if tenant is already linked to another user
      const existingLinkCheck = await client.query(
        'SELECT id, username FROM users WHERE tenant_id = $1 AND id != $2',
        [tenantId, userId]
      );
      
      if (existingLinkCheck.rows.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'This tenant is already linked to another user account'
        });
      }
      
      // Update user with tenant link
      const result = await client.query(`
        UPDATE users 
        SET tenant_id = $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING id, username, tenant_id
      `, [tenantId, userId]);
      
      // Log the linking
      await client.query(`
        INSERT INTO user_activity_log (
          user_id, activity_type, activity_description, 
          affected_resource_type, affected_resource_id, ip_address
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        userId, 
        'TENANT_LINKED', 
        `User linked to tenant: ${tenantCheck.rows[0].first_name} ${tenantCheck.rows[0].last_name}`,
        'tenant',
        tenantId,
        req.ip
      ]);
      
      await client.query('COMMIT');
      
      res.json({
        success: true,
        data: {
          user_id: userId,
          tenant_id: tenantId,
          tenant_name: `${tenantCheck.rows[0].first_name} ${tenantCheck.rows[0].last_name}`
        },
        message: 'User successfully linked to tenant'
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error linking user to tenant:', error);
      res.status(500).json({
        success: false,
        message: 'Error linking user to tenant',
        error: error.message
      });
    } finally {
      client.release();
    }
  });
  
  // Unlink tenant from user
  router.delete('/users/:id/unlink-tenant', authenticateToken,  async (req, res) => {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const { id } = req.params;
      const userId = parseInt(id);
      
      if (isNaN(userId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user ID'
        });
      }
      
      // Check if user exists and is linked to a tenant
      const userCheck = await client.query(`
        SELECT u.id, u.username, u.tenant_id, t.first_name, t.last_name
        FROM users u
        LEFT JOIN tenants t ON u.tenant_id = t.id
        WHERE u.id = $1
      `, [userId]);
      
      if (userCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      const user = userCheck.rows[0];
      
      if (!user.tenant_id) {
        return res.status(400).json({
          success: false,
          message: 'User is not linked to any tenant'
        });
      }
      
      // Unlink tenant
      await client.query(`
        UPDATE users 
        SET tenant_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [userId]);
      
      // Log the unlinking
      await client.query(`
        INSERT INTO user_activity_log (
          user_id, activity_type, activity_description, 
          affected_resource_type, affected_resource_id, ip_address
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        userId, 
        'TENANT_UNLINKED', 
        `User unlinked from tenant: ${user.first_name} ${user.last_name}`,
        'tenant',
        user.tenant_id,
        req.ip
      ]);
      
      await client.query('COMMIT');
      
      res.json({
        success: true,
        message: 'User successfully unlinked from tenant'
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error unlinking user from tenant:', error);
      res.status(500).json({
        success: false,
        message: 'Error unlinking user from tenant',
        error: error.message
      });
    } finally {
      client.release();
    }
  });

  // Get all tenants with filtering options
router.get('/tenants', async (req, res) => {
    try {
      const { search, employment_status, has_active_lease, has_user_account } = req.query;
      
      let query = `
        SELECT 
          t.id,
          t.first_name,
          t.last_name,
          t.email,
          t.phone,
          t.alternate_phone,
          t.date_of_birth,
          t.employment_status,
          t.employer_name,
          t.monthly_income,
          t.created_at,
          
          -- Check if tenant has active lease
          CASE WHEN al.lease_id IS NOT NULL THEN true ELSE false END as has_active_lease,
          al.property_name,
          al.unit_number,
          al.lease_number,
          al.lease_start_date,
          al.lease_end_date,
          
          -- Check if tenant has user account
          CASE WHEN u.id IS NOT NULL THEN true ELSE false END as has_user_account,
          u.username,
          u.is_active as user_is_active
          
        FROM tenants t
        LEFT JOIN (
          SELECT DISTINCT
            lt.tenant_id,
            l.id as lease_id,
            l.lease_number,
            l.start_date as lease_start_date,
            l.end_date as lease_end_date,
            p.property_name,
            u.unit_number
          FROM lease_tenants lt
          JOIN leases l ON lt.lease_id = l.id
          JOIN units u ON l.unit_id = u.id
          JOIN properties p ON u.property_id = p.id
          WHERE l.lease_status = 'active' 
          AND lt.removed_date IS NULL
        ) al ON t.id = al.tenant_id
        LEFT JOIN users u ON t.id = u.tenant_id AND u.is_active = true
      `;
      
      let whereConditions = [];
      let queryParams = [];
      let paramIndex = 1;
      
      // Search filter
      if (search) {
        whereConditions.push(`(
          t.first_name ILIKE $${paramIndex} OR 
          t.last_name ILIKE $${paramIndex} OR 
          t.email ILIKE $${paramIndex} OR
          CONCAT(t.first_name, ' ', t.last_name) ILIKE $${paramIndex}
        )`);
        queryParams.push(`%${search}%`);
        paramIndex++;
      }
      
      // Employment status filter
      if (employment_status) {
        whereConditions.push(`t.employment_status = $${paramIndex}`);
        queryParams.push(employment_status);
        paramIndex++;
      }
      
      // Active lease filter
      if (has_active_lease !== undefined) {
        if (has_active_lease === 'true') {
          whereConditions.push(`al.lease_id IS NOT NULL`);
        } else if (has_active_lease === 'false') {
          whereConditions.push(`al.lease_id IS NULL`);
        }
      }
      
      // User account filter
      if (has_user_account !== undefined) {
        if (has_user_account === 'true') {
          whereConditions.push(`u.id IS NOT NULL`);
        } else if (has_user_account === 'false') {
          whereConditions.push(`u.id IS NULL`);
        }
      }
      
      // Add WHERE clause if there are conditions
      if (whereConditions.length > 0) {
        query += ' WHERE ' + whereConditions.join(' AND ');
      }
      
      query += ' ORDER BY t.last_name, t.first_name';
      
      const result = await pool.query(query, queryParams);
      
      res.json({
        success: true,
        data: result.rows,
        total: result.rows.length,
        filters_applied: {
          search: search || null,
          employment_status: employment_status || null,
          has_active_lease: has_active_lease || null,
          has_user_account: has_user_account || null
        }
      });
      
    } catch (error) {
      console.error('Error fetching tenants:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching tenants',
        error: error.message
      });
    }
  });
  
// SESSION MANAGEMENT ROUTES

// Get user sessions
router.get('/users/:id/sessions',  authenticateTokenSimple, async (req, res) => {
    try {
      const { id } = req.params;
      const { active_only = false } = req.query;
      const userId = parseInt(id);
      
      if (isNaN(userId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user ID'
        });
      }
      
      let query = `
        SELECT 
          id,
          session_token,
          device_info,
          ip_address,
          user_agent,
          is_active,
          expires_at,
          created_at,
          last_activity,
          CASE 
            WHEN expires_at < CURRENT_TIMESTAMP THEN true
            ELSE false
          END as is_expired
        FROM user_sessions 
        WHERE user_id = $1
      `;
      
      if (active_only === 'true') {
        query += ` AND is_active = true AND expires_at > CURRENT_TIMESTAMP`;
      }
      
      query += ` ORDER BY last_activity DESC`;
      
      const result = await pool.query(query, [userId]);
      
      res.json({
        success: true,
        data: result.rows,
        total: result.rows.length
      });
      
    } catch (error) {
      console.error('Error fetching user sessions:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching user sessions',
        error: error.message
      });
    }
  });
  
  // Terminate specific session
  router.delete('/users/:id/sessions/:sessionId',  authenticateTokenSimple, async (req, res) => {
    try {
      const { id, sessionId } = req.params;
      const userId = parseInt(id);
      const sessionIdInt = parseInt(sessionId);
      
      if (isNaN(userId) || isNaN(sessionIdInt)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user ID or session ID'
        });
      }
      
      const result = await pool.query(`
        UPDATE user_sessions 
        SET is_active = false, last_activity = CURRENT_TIMESTAMP
        WHERE id = $1 AND user_id = $2 AND is_active = true
        RETURNING id, session_token
      `, [sessionIdInt, userId]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Active session not found'
        });
      }
      
      // Log session termination
      await pool.query(`
        INSERT INTO user_activity_log (
          user_id, activity_type, activity_description, ip_address
        ) VALUES ($1, $2, $3, $4)
      `, [
        userId, 
        'SESSION_TERMINATED', 
        `Session terminated by administrator`, 
        req.ip
      ]);
      
      res.json({
        success: true,
        message: 'Session terminated successfully'
      });
      
    } catch (error) {
      console.error('Error terminating session:', error);
      res.status(500).json({
        success: false,
        message: 'Error terminating session',
        error: error.message
      });
    }
  });
  
  // Terminate all sessions for a user
  router.delete('/users/:id/sessions',  authenticateTokenSimple, async (req, res) => {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const { id } = req.params;
      const userId = parseInt(id);
      
      if (isNaN(userId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user ID'
        });
      }
      
      // Terminate all active sessions
      const result = await client.query(`
        UPDATE user_sessions 
        SET is_active = false, last_activity = CURRENT_TIMESTAMP
        WHERE user_id = $1 AND is_active = true
        RETURNING id
      `, [userId]);
      
      const terminatedCount = result.rows.length;
      
      // Log mass session termination
      await client.query(`
        INSERT INTO user_activity_log (
          user_id, activity_type, activity_description, ip_address
        ) VALUES ($1, $2, $3, $4)
      `, [
        userId, 
        'ALL_SESSIONS_TERMINATED', 
        `All ${terminatedCount} active sessions terminated by administrator`, 
        req.ip
      ]);
      
      await client.query('COMMIT');
      
      res.json({
        success: true,
        data: { terminated_sessions: terminatedCount },
        message: `${terminatedCount} active sessions terminated successfully`
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error terminating all sessions:', error);
      res.status(500).json({
        success: false,
        message: 'Error terminating sessions',
        error: error.message
      });
    } finally {
      client.release();
    }
  });
  
  // UTILITY ROUTES
  
  // Search users for autocomplete/dropdown
  router.get('/users/search',  authenticateTokenSimple, async (req, res) => {
    try {
      const { q, role, limit = 10 } = req.query;
      
      if (!q || q.length < 2) {
        return res.json({
          success: true,
          data: []
        });
      }
      
      let query = `
        SELECT 
          u.id,
          u.username,
          u.email,
          u.first_name,
          u.last_name,
          ur.role_name
        FROM users u
        JOIN user_roles ur ON u.role_id = ur.id
        WHERE u.is_active = true
        AND (
          u.first_name ILIKE $1 OR 
          u.last_name ILIKE $1 OR 
          u.username ILIKE $1 OR
          u.email ILIKE $1 OR
          CONCAT(u.first_name, ' ', u.last_name) ILIKE $1
        )
      `;
      
      let queryParams = [`%${q}%`];
      let paramIndex = 2;
      
      if (role) {
        query += ` AND ur.role_name = $${paramIndex}`;
        queryParams.push(role);
        paramIndex++;
      }
      
      query += ` ORDER BY u.first_name, u.last_name LIMIT $${paramIndex}`;
      queryParams.push(parseInt(limit));
      
      const result = await pool.query(query, queryParams);
      
      res.json({
        success: true,
        data: result.rows
      });
      
    } catch (error) {
      console.error('Error searching users:', error);
      res.status(500).json({
        success: false,
        message: 'Error searching users',
        error: error.message
      });
    }
  });
  
  // Get user profile (for current logged in user)
  router.get('/profile',  authenticateTokenSimple, async (req, res) => {
    try {
      const userId = req.user.id; // Assuming user ID is available in req.user from auth middleware
      
      const query = `
        SELECT 
          u.id,
          u.username,
          u.email,
          u.first_name,
          u.last_name,
          u.phone,
          u.is_active,
          u.is_verified,
          u.last_login,
          u.profile_image_url,
          u.timezone,
          u.language,
          u.notification_preferences,
          u.two_factor_enabled,
          u.created_at,
          u.updated_at,
          ur.role_name,
          ur.description as role_description,
          ur.permissions,
          CASE 
            WHEN u.tenant_id IS NOT NULL THEN t.first_name || ' ' || t.last_name 
            ELSE NULL 
          END as linked_tenant_name,
          (SELECT COUNT(*) FROM user_notifications WHERE user_id = u.id AND is_read = false) as unread_notifications
        FROM users u
        JOIN user_roles ur ON u.role_id = ur.id
        LEFT JOIN tenants t ON u.tenant_id = t.id
        WHERE u.id = $1
      `;
      
      const result = await pool.query(query, [userId]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      res.json({
        success: true,
        data: result.rows[0]
      });
      
    } catch (error) {
      console.error('Error fetching user profile:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching user profile',
        error: error.message
      });
    }
  });
  
  // Update user profile (for current logged in user)
  router.put('/profile',  authenticateTokenSimple, async (req, res) => {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const userId = req.user.id;
      const {
        first_name,
        last_name,
        phone,
        timezone,
        language,
        notification_preferences,
        current_password,
        new_password
      } = req.body;
      
      // Build update query dynamically
      let updateFields = [];
      let updateValues = [];
      let paramIndex = 1;
      
      if (first_name) {
        updateFields.push(`first_name = $${paramIndex}`);
        updateValues.push(first_name);
        paramIndex++;
      }
      
      if (last_name) {
        updateFields.push(`last_name = $${paramIndex}`);
        updateValues.push(last_name);
        paramIndex++;
      }
      
      if (phone !== undefined) {
        updateFields.push(`phone = $${paramIndex}`);
        updateValues.push(phone);
        paramIndex++;
      }
      
      if (timezone) {
        updateFields.push(`timezone = $${paramIndex}`);
        updateValues.push(timezone);
        paramIndex++;
      }
      
      if (language) {
        updateFields.push(`language = $${paramIndex}`);
        updateValues.push(language);
        paramIndex++;
      }
      
      if (notification_preferences) {
        updateFields.push(`notification_preferences = $${paramIndex}`);
        updateValues.push(JSON.stringify(notification_preferences));
        paramIndex++;
      }
      
      // Handle password change
      if (new_password && current_password) {
        // Verify current password
        const userResult = await client.query(
          'SELECT password_hash FROM users WHERE id = $1',
          [userId]
        );
        
        if (userResult.rows.length === 0) {
          return res.status(404).json({
            success: false,
            message: 'User not found'
          });
        }
        
        const isValidPassword = await bcrypt.compare(current_password, userResult.rows[0].password_hash);
        
        if (!isValidPassword) {
          return res.status(400).json({
            success: false,
            message: 'Current password is incorrect'
          });
        }
        
        if (new_password.length < 8) {
          return res.status(400).json({
            success: false,
            message: 'New password must be at least 8 characters long'
          });
        }
        
        const saltRounds = 12;
        const password_hash = await bcrypt.hash(new_password, saltRounds);
        updateFields.push(`password_hash = $${paramIndex}`);
        updateValues.push(password_hash);
        paramIndex++;
      }
      
      if (updateFields.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No fields to update'
        });
      }
      
      // Add updated_at timestamp
      updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
      updateValues.push(userId);
      
      const updateQuery = `
        UPDATE users 
        SET ${updateFields.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING id, username, email, first_name, last_name, phone, updated_at
      `;
      
      const result = await client.query(updateQuery, updateValues);
      
      // Log the profile update
      await client.query(`
        INSERT INTO user_activity_log (
          user_id, activity_type, activity_description, ip_address
        ) VALUES ($1, $2, $3, $4)
      `, [
        userId, 
        'PROFILE_UPDATED', 
        'User updated their profile', 
        req.ip
      ]);
      
      await client.query('COMMIT');
      
      res.json({
        success: true,
        data: result.rows[0],
        message: 'Profile updated successfully'
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error updating profile:', error);
      res.status(500).json({
        success: false,
        message: 'Error updating profile',
        error: error.message
      });
    } finally {
      client.release();
    }
  });
  
  // Export user data (Admin only)
  router.get('/users/export', authenticateToken,  async (req, res) => {
    try {
      const { format = 'json', include_inactive = false } = req.query;
      
      let query = `
        SELECT 
          u.id,
          u.username,
          u.email,
          u.first_name,
          u.last_name,
          u.phone,
          ur.role_name,
          u.is_active,
          u.is_verified,
          u.last_login,
          u.created_at,
          u.updated_at,
          CASE 
            WHEN u.tenant_id IS NOT NULL THEN t.first_name || ' ' || t.last_name 
            ELSE NULL 
          END as linked_tenant
        FROM users u
        JOIN user_roles ur ON u.role_id = ur.id
        LEFT JOIN tenants t ON u.tenant_id = t.id
      `;
      
      if (include_inactive !== 'true') {
        query += ' WHERE u.is_active = true';
      }
      
      query += ' ORDER BY u.created_at DESC';
      
      const result = await pool.query(query);
      
      if (format === 'csv') {
        // Convert to CSV format
        const csvHeader = 'ID,Username,Email,First Name,Last Name,Phone,Role,Active,Verified,Last Login,Created,Updated,Linked Tenant\n';
        const csvRows = result.rows.map(user => [
          user.id,
          user.username,
          user.email,
          user.first_name,
          user.last_name,
          user.phone || '',
          user.role_name,
          user.is_active,
          user.is_verified,
          user.last_login || '',
          user.created_at,
          user.updated_at,
          user.linked_tenant || ''
        ].join(',')).join('\n');
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=users_export.csv');
        res.send(csvHeader + csvRows);
      } else {
        res.json({
          success: true,
          data: result.rows,
          total: result.rows.length,
          exported_at: new Date().toISOString()
        });
      }
      
      // Log the export activity
      await pool.query(`
        INSERT INTO user_activity_log (
          user_id, activity_type, activity_description, ip_address
        ) VALUES ($1, $2, $3, $4)
      `, [
        req.user.id, 
        'USERS_EXPORTED', 
        `Exported ${result.rows.length} users in ${format} format`, 
        req.ip
      ]);
      
    } catch (error) {
      console.error('Error exporting users:', error);
      res.status(500).json({
        success: false,
        message: 'Error exporting users',
        error: error.message
      });
    }
  });
  
  // Clean up expired sessions (Admin utility)
  router.post('/users/cleanup-sessions', authenticateToken,  async (req, res) => {
    try {
      // Use the database function to cleanup expired sessions
      await pool.query('SELECT cleanup_expired_sessions()');
      
      // Get count of cleaned up sessions
      const result = await pool.query(`
        SELECT COUNT(*) as cleaned_count 
        FROM user_sessions 
        WHERE expires_at < CURRENT_TIMESTAMP AND is_active = false
      `);
      
      const cleanedCount = parseInt(result.rows[0].cleaned_count);
      
      // Log the cleanup activity
      await pool.query(`
        INSERT INTO user_activity_log (
          user_id, activity_type, activity_description, ip_address
        ) VALUES ($1, $2, $3, $4)
      `, [
        req.user.id, 
        'SESSIONS_CLEANUP', 
        `Cleaned up ${cleanedCount} expired sessions`, 
        req.ip
      ]);
      
      res.json({
        success: true,
        message: `Successfully cleaned up expired sessions`,
        cleaned_sessions: cleanedCount
      });
      
    } catch (error) {
      console.error('Error cleaning up sessions:', error);
      res.status(500).json({
        success: false,
        message: 'Error cleaning up sessions',
        error: error.message
      });
    }
  });
  
  // Get system user statistics
  router.get('/users/system-stats', authenticateToken,  async (req, res) => {
    try {
      const stats = await pool.query(`
        SELECT 
          COUNT(*) as total_users,
          COUNT(CASE WHEN is_active = true THEN 1 END) as active_users,
          COUNT(CASE WHEN is_active = false THEN 1 END) as inactive_users,
          COUNT(CASE WHEN is_verified = false AND is_active = true THEN 1 END) as unverified_users,
          COUNT(CASE WHEN last_login > CURRENT_TIMESTAMP - INTERVAL '24 hours' THEN 1 END) as active_today,
          COUNT(CASE WHEN last_login > CURRENT_TIMESTAMP - INTERVAL '7 days' THEN 1 END) as active_week,
          COUNT(CASE WHEN created_at > CURRENT_TIMESTAMP - INTERVAL '30 days' THEN 1 END) as new_this_month
        FROM users
      `);
      
      const roleStats = await pool.query(`
        SELECT 
          ur.role_name,
          COUNT(u.id) as user_count
        FROM user_roles ur
        LEFT JOIN users u ON ur.id = u.role_id AND u.is_active = true
        GROUP BY ur.id, ur.role_name
        ORDER BY user_count DESC
      `);
      
      const sessionStats = await pool.query(`
        SELECT 
          COUNT(*) as total_sessions,
          COUNT(CASE WHEN is_active = true AND expires_at > CURRENT_TIMESTAMP THEN 1 END) as active_sessions,
          COUNT(CASE WHEN created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours' THEN 1 END) as sessions_today
        FROM user_sessions
      `);
      
      res.json({
        success: true,
        data: {
          user_stats: stats.rows[0],
          role_breakdown: roleStats.rows,
          session_stats: sessionStats.rows[0],
          generated_at: new Date().toISOString()
        }
      });
      
    } catch (error) {
      console.error('Error fetching system stats:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching system statistics',
        error: error.message
      });
    }
  });
  
  // ADVANCED ROUTES
  
  // Send notification to user
  router.post('/users/:id/notifications', authenticateToken, async (req, res) => {
    try {
      const { id } = req.params;
      const {
        notification_type,
        title,
        message,
        is_urgent = false,
        delivery_method = 'in_app',
        related_resource_type,
        related_resource_id
      } = req.body;
      
      const userId = parseInt(id);
      
      if (isNaN(userId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user ID'
        });
      }
      
      if (!notification_type || !title || !message) {
        return res.status(400).json({
          success: false,
          message: 'notification_type, title, and message are required'
        });
      }
      
      // Check if user exists
      const userCheck = await pool.query(
        'SELECT id FROM users WHERE id = $1',
        [userId]
      );
      
      if (userCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      // Create notification using database function
      const result = await pool.query(`
        SELECT create_user_notification($1, $2, $3, $4, $5, $6, $7, $8) as notification_id
      `, [
        userId,
        notification_type,
        title,
        message,
        is_urgent,
        related_resource_type,
        related_resource_id,
        delivery_method
      ]);
      
      const notificationId = result.rows[0].notification_id;
      
      res.status(201).json({
        success: true,
        data: { notification_id: notificationId },
        message: 'Notification created successfully'
      });
      
    } catch (error) {
      console.error('Error creating notification:', error);
      res.status(500).json({
        success: false,
        message: 'Error creating notification',
        error: error.message
      });
    }
  });
  
  // Get user login attempts and security info
  router.get('/users/:id/security', authenticateToken, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = parseInt(id);
      
      if (isNaN(userId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user ID'
        });
      }
      
      const securityQuery = `
        SELECT 
          u.failed_login_attempts,
          u.locked_until,
          u.two_factor_enabled,
          u.password_reset_token IS NOT NULL as has_reset_token,
          u.password_reset_expires,
          u.email_verification_token IS NOT NULL as has_verification_token,
          u.email_verification_expires,
          (SELECT COUNT(*) FROM user_sessions WHERE user_id = u.id) as total_sessions,
          (SELECT COUNT(*) FROM user_sessions WHERE user_id = u.id AND is_active = true AND expires_at > CURRENT_TIMESTAMP) as active_sessions,
          (SELECT MAX(last_activity) FROM user_sessions WHERE user_id = u.id) as last_session_activity
        FROM users u
        WHERE u.id = $1
      `;
      
      const result = await pool.query(securityQuery, [userId]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      // Get recent security-related activities
      const activityQuery = `
        SELECT 
          activity_type,
          activity_description,
          activity_timestamp,
          ip_address
        FROM user_activity_log
        WHERE user_id = $1 
        AND activity_type IN ('USER_LOGIN', 'USER_LOGOUT', 'PASSWORD_RESET', 'FAILED_LOGIN', 'ACCOUNT_LOCKED', 'ACCOUNT_UNLOCKED')
        ORDER BY activity_timestamp DESC
        LIMIT 10
      `;
      
      const activityResult = await pool.query(activityQuery, [userId]);
      
      res.json({
        success: true,
        data: {
          security_info: result.rows[0],
          recent_activities: activityResult.rows
        }
      });
      
    } catch (error) {
      console.error('Error fetching user security info:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching user security information',
        error: error.message
      });
    }
  });
  
  // Unlock user account (Admin only)
  router.post('/users/:id/unlock', authenticateToken,  async (req, res) => {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const { id } = req.params;
      const userId = parseInt(id);
      
      if (isNaN(userId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user ID'
        });
      }
      
      // Check if user exists and is locked
      const userCheck = await client.query(`
        SELECT id, username, locked_until, failed_login_attempts
        FROM users 
        WHERE id = $1
      `, [userId]);
      
      if (userCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      const user = userCheck.rows[0];
      
      if (!user.locked_until || new Date(user.locked_until) <= new Date()) {
        return res.status(400).json({
          success: false,
          message: 'User account is not currently locked'
        });
      }
      
      // Unlock the account
      await client.query(`
        UPDATE users 
        SET locked_until = NULL, failed_login_attempts = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [userId]);
      
      // Log the unlock activity
      await client.query(`
        INSERT INTO user_activity_log (
          user_id, activity_type, activity_description, ip_address
        ) VALUES ($1, $2, $3, $4)
      `, [
        userId,
        'ACCOUNT_UNLOCKED',
        `Account manually unlocked by administrator`,
        req.ip
      ]);
      
      await client.query('COMMIT');
      
      res.json({
        success: true,
        message: 'User account unlocked successfully'
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error unlocking user account:', error);
      res.status(500).json({
        success: false,
        message: 'Error unlocking user account',
        error: error.message
      });
    } finally {
      client.release();
    }
  });

 // Manual email verification (Admin only) - FIXED VERSION
router.patch('/users/:id/verify-email', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const { is_verified } = req.body;
    const userId = parseInt(id);
    
    if (isNaN(userId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID'
      });
    }
    
    if (is_verified === undefined) {
      return res.status(400).json({
        success: false,
        message: 'is_verified field is required'
      });
    }
    
    // Check if user exists
    const userCheck = await client.query(
      'SELECT id, username, email, is_verified FROM users WHERE id = $1',
      [userId]
    );
    
    if (userCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    const currentUser = userCheck.rows[0];
    
    if (currentUser.is_verified === is_verified) {
      return res.status(400).json({
        success: false,
        message: `Email is already ${is_verified ? 'verified' : 'unverified'}`
      });
    }
    
    // Update email verification status and clear related fields
    let updateQuery = `
      UPDATE users 
      SET is_verified = $1, 
          updated_at = CURRENT_TIMESTAMP,
          email_verification_token = NULL,
          email_verification_expires = NULL
    `;
    
    let updateValues = [is_verified];
    let paramIndex = 2;
    
    // When manually verifying, also clear password reset tokens and failed login attempts
    if (is_verified) {
      updateQuery += `, 
          password_reset_token = NULL,
          password_reset_expires = NULL,
          failed_login_attempts = 0,
          locked_until = NULL
      `;
    }
    
    // FIX: Use proper parameter placeholder syntax
    updateQuery += ` WHERE id = $${paramIndex} RETURNING id, username, email, is_verified, updated_at`;
    updateValues.push(userId);
    
    const result = await client.query(updateQuery, updateValues);
    
    // Log the verification change
    await client.query(`
      INSERT INTO user_activity_log (
        user_id, activity_type, activity_description, ip_address
      ) VALUES ($1, $2, $3, $4)
    `, [
      userId, 
      is_verified ? 'EMAIL_VERIFIED_MANUAL' : 'EMAIL_UNVERIFIED_MANUAL', 
      `Email ${is_verified ? 'verified' : 'unverified'} manually by administrator`, 
      req.ip
    ]);
    
    // Create notification for user about email verification change
    if (is_verified) {
      await client.query(`
        INSERT INTO user_notifications (
          user_id, notification_type, title, message, is_urgent
        ) VALUES ($1, $2, $3, $4, $5)
      `, [
        userId,
        'EMAIL_VERIFIED',
        'Email Verified',
        'Your email address has been verified by an administrator. You can now log in to your account.',
        false
      ]);
    }
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      data: result.rows[0],
      message: `Email ${is_verified ? 'verified' : 'unverified'} successfully. ${is_verified ? 'User can now log in.' : ''}`
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating email verification:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating email verification',
      error: error.message
    });
  } finally {
    client.release();
  }
});
  export default router;