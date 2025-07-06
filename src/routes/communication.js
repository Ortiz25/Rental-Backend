import express from 'express';
import pool from '../config/database.js';
import { authenticateToken, authorizeRole, authenticateTokenSimple } from '../middleware/auth.js';

const router = express.Router();

// Get all messages/communications with filtering and pagination
router.get('/messages', authenticateTokenSimple, async (req, res) => {
  console.log('📨 Getting messages for user:', req.user?.id);
  
  const client = await pool.connect();
  
  try {
    const { 
      page = 1, 
      limit = 10, 
      type = 'all', 
      status = 'all',
      priority = 'all',
      search = '',
      tenant_id = null 
    } = req.query;
    
    const offset = (page - 1) * limit;
    
    // Build dynamic WHERE clause
    let whereConditions = [];
    let queryParams = [];
    let paramCount = 0;
    
    // Filter by communication type
    if (type !== 'all') {
      paramCount++;
      whereConditions.push(`c.communication_type = $${paramCount}`);
      queryParams.push(type);
    }
    
    // Filter by tenant (for tenant users or specific tenant filter)
    if (req.user.role === 'Tenant' && req.user.tenant_id) {
      paramCount++;
      whereConditions.push(`c.tenant_id = $${paramCount}`);
      queryParams.push(req.user.tenant_id);
    } else if (tenant_id && tenant_id !== 'null') {
      paramCount++;
      whereConditions.push(`c.tenant_id = $${paramCount}`);
      queryParams.push(tenant_id);
    }
    
    // Search functionality
    if (search && search.trim() !== '') {
      paramCount++;
      whereConditions.push(`(
        c.subject ILIKE $${paramCount} OR 
        c.message_content ILIKE $${paramCount} OR 
        COALESCE(t.first_name || ' ' || t.last_name, '') ILIKE $${paramCount}
      )`);
      queryParams.push(`%${search.trim()}%`);
    }
    
    // If no conditions, add a default true condition
    if (whereConditions.length === 0) {
      whereConditions.push('1=1');
    }
    
    const whereClause = whereConditions.join(' AND ');
    
    // Store params for count query (without limit/offset)
    const countParams = [...queryParams];
    
    // Add pagination parameters
    paramCount++;
    queryParams.push(limit);
    const limitParam = paramCount;
    
    paramCount++;
    queryParams.push(offset);
    const offsetParam = paramCount;
    
    const messagesQuery = `
      SELECT 
        c.id,
        c.subject,
        c.message_content as content,
        c.communication_type,
        c.direction,
        c.communication_date as timestamp,
        c.follow_up_required,
        c.follow_up_date,
        c.staff_member,
        t.id as tenant_id,
        COALESCE(t.first_name || ' ' || t.last_name, 'Unknown') as tenant_name,
        t.email as tenant_email,
        t.phone as tenant_phone,
        COALESCE(p.property_name, 'N/A') as property_name,
        COALESCE(u.unit_number, '') as unit_number,
        COALESCE(l.lease_number, '') as lease_number,
        CASE 
          WHEN c.follow_up_required AND c.follow_up_date <= CURRENT_DATE THEN 'high'
          WHEN c.follow_up_required THEN 'normal'
          ELSE 'low'
        END as priority,
        CASE 
          WHEN c.follow_up_required AND c.follow_up_date <= CURRENT_DATE THEN 'pending'
          WHEN c.direction = 'inbound' AND c.follow_up_required THEN 'unread'
          ELSE 'read'
        END as status
      FROM communications c
      LEFT JOIN tenants t ON c.tenant_id = t.id
      LEFT JOIN lease_tenants lt ON t.id = lt.tenant_id AND lt.removed_date IS NULL
      LEFT JOIN leases l ON lt.lease_id = l.id AND l.lease_status = 'active'
      LEFT JOIN units u ON l.unit_id = u.id
      LEFT JOIN properties p ON u.property_id = p.id
      WHERE ${whereClause}
      ORDER BY c.communication_date DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}
    `;
    
    // Count query for pagination
    const countQuery = `
      SELECT COUNT(*) as total
      FROM communications c
      LEFT JOIN tenants t ON c.tenant_id = t.id
      WHERE ${whereClause}
    `;
    
    console.log('Executing messages query with params:', queryParams);
    console.log('Executing count query with params:', countParams);
    
    const [messagesResult, countResult] = await Promise.all([
      client.query(messagesQuery, queryParams),
      client.query(countQuery, countParams)
    ]);
    
    const messages = messagesResult.rows.map(row => ({
      id: row.id,
      sender: row.direction === 'inbound' ? row.tenant_name : (row.staff_member || 'Staff'),
      property: row.unit_number ? `${row.property_name} - Unit ${row.unit_number}` : row.property_name,
      content: row.content || '',
      subject: row.subject || '',
      timestamp: row.timestamp,
      status: row.status,
      priority: row.priority,
      type: row.communication_type?.toLowerCase() || 'general',
      direction: row.direction,
      tenant: {
        id: row.tenant_id,
        name: row.tenant_name,
        email: row.tenant_email,
        phone: row.tenant_phone
      },
      followUp: {
        required: row.follow_up_required || false,
        date: row.follow_up_date
      }
    }));
    
    const totalMessages = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalMessages / limit);
    
    res.status(200).json({
      status: 200,
      message: 'Messages retrieved successfully',
      data: {
        messages,
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalMessages,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1
        }
      }
    });
    
  } catch (error) {
    console.error('❌ Error fetching messages:', error);
    res.status(500).json({
      status: 500,
      message: 'Failed to fetch messages',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// Send a new message
router.post('/messages', authenticateTokenSimple, async (req, res) => {
  console.log('📤 Sending new message from user:', req.user?.id);
  
  const client = await pool.connect();
  
  try {
    const {
      tenant_id,
      lease_id,
      communication_type = 'Email',
      subject,
      message_content,
      direction = 'outbound',
      follow_up_required = false,
      follow_up_date = null
    } = req.body;
    
    // Validation
    if (!subject || !message_content) {
      return res.status(400).json({
        status: 400,
        message: 'Subject and message content are required'
      });
    }
    
    if (!tenant_id && !lease_id) {
      return res.status(400).json({
        status: 400,
        message: 'Either tenant_id or lease_id is required'
      });
    }
    
    // If user is a tenant, they can only send messages for themselves
    if (req.user.role === 'Tenant') {
      if (tenant_id && tenant_id !== req.user.tenant_id) {
        return res.status(403).json({
          status: 403,
          message: 'You can only send messages for your own account'
        });
      }
    }
    
    const insertQuery = `
      INSERT INTO communications (
        tenant_id,
        lease_id,
        communication_type,
        subject,
        message_content,
        direction,
        staff_member,
        follow_up_required,
        follow_up_date,
        communication_date
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
      RETURNING id, communication_date
    `;
    
    const staff_member = req.user.role === 'Tenant' ? null : `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim();
    const final_direction = req.user.role === 'Tenant' ? 'inbound' : direction;
    
    const result = await client.query(insertQuery, [
      tenant_id || null,
      lease_id || null,
      communication_type,
      subject,
      message_content,
      final_direction,
      staff_member,
      follow_up_required,
      follow_up_date
    ]);
    
    // Log user activity (only if user has proper structure)
    if (req.user.id) {
      try {
        await client.query(`
          SELECT log_user_activity($1, $2, $3, $4, $5)
        `, [
          req.user.id,
          'message_sent',
          `Sent message: ${subject}`,
          'communication',
          result.rows[0].id
        ]);
      } catch (logError) {
        console.log('Could not log activity:', logError.message);
      }
    }
    
    // Create notification for recipient if message is from staff to tenant
    if (final_direction === 'outbound' && tenant_id) {
      try {
        const tenantUserQuery = `
          SELECT id FROM users WHERE tenant_id = $1 AND is_active = true
        `;
        const tenantUserResult = await client.query(tenantUserQuery, [tenant_id]);
        
        if (tenantUserResult.rows.length > 0) {
          await client.query(`
            SELECT create_user_notification($1, $2, $3, $4, $5, $6, $7)
          `, [
            tenantUserResult.rows[0].id,
            'new_message',
            'New Message Received',
            `You have a new message: ${subject}`,
            false,
            'communication',
            result.rows[0].id
          ]);
        }
      } catch (notifError) {
        console.log('Could not create notification:', notifError.message);
      }
    }
    
    res.status(201).json({
      status: 201,
      message: 'Message sent successfully',
      data: {
        id: result.rows[0].id,
        timestamp: result.rows[0].communication_date
      }
    });
    
  } catch (error) {
    console.error('❌ Error sending message:', error);
    res.status(500).json({
      status: 500,
      message: 'Failed to send message',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// Get communication statistics

router.get('/stats', authenticateTokenSimple, async (req, res) => {
  console.log('📊 Getting communication stats for user:', req.user?.id);
  
  const client = await pool.connect();
  
  try {
    let whereClause = '';
    let queryParams = [];
    
    // If tenant user, only show their stats
    if (req.user.role === 'Tenant' && req.user.tenant_id) {
      whereClause = 'WHERE c.tenant_id = $1';
      queryParams = [req.user.tenant_id];
    }
    
    const statsQuery = `
      SELECT 
        COUNT(*) as total_messages,
        COUNT(CASE WHEN c.direction = 'inbound' THEN 1 END) as inbound_messages,
        COUNT(CASE WHEN c.direction = 'outbound' THEN 1 END) as outbound_messages,
        COUNT(CASE WHEN c.follow_up_required AND c.follow_up_date <= CURRENT_DATE THEN 1 END) as pending_followups,
        COUNT(CASE WHEN c.communication_date >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as messages_this_week,
        COUNT(CASE WHEN c.communication_date >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as messages_this_month
      FROM communications c
      ${whereClause}
    `;
    
    // FIXED: Separate notification stats to properly distinguish announcements from other notifications
    let notificationStatsQuery = `
      SELECT 
        COUNT(*) as total_notifications,
        COUNT(CASE WHEN is_read = false THEN 1 END) as unread_notifications,
        COUNT(CASE WHEN notification_type = 'announcement' THEN 1 END) as announcements,
        COUNT(CASE WHEN notification_type = 'announcement' AND is_read = false THEN 1 END) as unread_announcements,
        COUNT(CASE WHEN is_urgent = true THEN 1 END) as urgent_notifications,
        COUNT(CASE WHEN notification_type = 'announcement' AND is_urgent = true THEN 1 END) as urgent_announcements
      FROM user_notifications
    `;
    
    let notificationParams = [];
    if (req.user.role === 'Tenant') {
      notificationStatsQuery += ' WHERE user_id = $1';
      notificationParams = [req.user.id];
    }
    
    const [statsResult, notificationResult] = await Promise.all([
      client.query(statsQuery, queryParams),
      client.query(notificationStatsQuery, notificationParams)
    ]);
    
    const stats = {
      messages: {
        total: parseInt(statsResult.rows[0].total_messages) || 0,
        inbound: parseInt(statsResult.rows[0].inbound_messages) || 0,
        outbound: parseInt(statsResult.rows[0].outbound_messages) || 0,
        pendingFollowups: parseInt(statsResult.rows[0].pending_followups) || 0,
        thisWeek: parseInt(statsResult.rows[0].messages_this_week) || 0,
        thisMonth: parseInt(statsResult.rows[0].messages_this_month) || 0,
        unread: parseInt(statsResult.rows[0].pending_followups) || 0 // Using pending followups as "unread" for messages
      },
      notifications: {
        total: parseInt(notificationResult.rows[0].total_notifications) || 0,
        unread: parseInt(notificationResult.rows[0].unread_notifications) || 0,
        announcements: parseInt(notificationResult.rows[0].announcements) || 0,
        unreadAnnouncements: parseInt(notificationResult.rows[0].unread_announcements) || 0,
        urgent: parseInt(notificationResult.rows[0].urgent_notifications) || 0,
        urgentAnnouncements: parseInt(notificationResult.rows[0].urgent_announcements) || 0
      }
    };
    
    // Log for debugging
    console.log('📊 Calculated stats:', stats);
    
    res.status(200).json({
      status: 200,
      message: 'Communication statistics retrieved successfully',
      data: stats
    });
    
  } catch (error) {
    console.error('❌ Error fetching communication stats:', error);
    res.status(500).json({
      status: 500,
      message: 'Failed to fetch communication statistics',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});
// Add these routes to your main communications router file

// Get announcements (using user_notifications table)

router.get('/announcements', authenticateTokenSimple, async (req, res) => {
    console.log('📢 Getting announcements for user:', req.user?.id);
    
    const client = await pool.connect();
    
    try {
      const { 
        page = 1, 
        limit = 10, 
        priority = 'all'
      } = req.query;
      
      const offset = (page - 1) * limit;
      
      // First, let's check if user_notifications table has any data
      const checkTableQuery = `
        SELECT COUNT(*) as count 
        FROM user_notifications 
        WHERE notification_type = 'announcement'
      `;
      
      const checkResult = await client.query(checkTableQuery);
      const totalCount = parseInt(checkResult.rows[0].count);
      
      if (totalCount === 0) {
        // Return empty result if no announcements exist
        return res.status(200).json({
          status: 200,
          message: 'No announcements found',
          data: {
            announcements: [],
            pagination: {
              currentPage: parseInt(page),
              totalPages: 0,
              totalAnnouncements: 0,
              hasNextPage: false,
              hasPreviousPage: false
            }
          }
        });
      }
      
      // Build the main query
      let mainQuery = `
        SELECT 
          n.id,
          n.title,
          n.message as content,
          n.is_urgent,
          n.created_at,
          n.is_read
        FROM user_notifications n
        WHERE notification_type = 'announcement'
      `;
      
      let countQuery = `
        SELECT COUNT(*) as total
        FROM user_notifications n
        WHERE notification_type = 'announcement'
      `;
      
      let queryParams = [];
      let paramCount = 0;
      
      // Add user filter for tenants
      if (req.user.role === 'Tenant') {
        paramCount++;
        mainQuery += ` AND n.user_id = $${paramCount}`;
        countQuery += ` AND n.user_id = $${paramCount}`;
        queryParams.push(req.user.id);
      }
      
      // Add priority filter
      if (priority !== 'all') {
        paramCount++;
        const isUrgent = priority === 'high';
        mainQuery += ` AND n.is_urgent = $${paramCount}`;
        countQuery += ` AND n.is_urgent = $${paramCount}`;
        queryParams.push(isUrgent);
      }
      
      // Store count params
      const countParams = [...queryParams];
      
      // Add ordering and pagination to main query
      mainQuery += ` ORDER BY n.created_at DESC`;
      
      // Add limit
      paramCount++;
      mainQuery += ` LIMIT $${paramCount}`;
      queryParams.push(parseInt(limit));
      
      // Add offset
      paramCount++;
      mainQuery += ` OFFSET $${paramCount}`;
      queryParams.push(parseInt(offset));
      
      console.log('Main query:', mainQuery);
      console.log('Count query:', countQuery);
      console.log('Main params:', queryParams);
      console.log('Count params:', countParams);
      
      const [announcementsResult, countResult] = await Promise.all([
        client.query(mainQuery, queryParams),
        client.query(countQuery, countParams)
      ]);
      
      const announcements = announcementsResult.rows.map(row => ({
        id: row.id,
        title: row.title,
        content: row.content,
        priority: row.is_urgent ? 'high' : 'normal',
        date: new Date(row.created_at).toISOString().split('T')[0],
        recipients: req.user.role === 'Tenant' ? 'You' : 'All Tenants',
        isRead: row.is_read,
        createdBy: 'System'
      }));
      
      const totalAnnouncements = parseInt(countResult.rows[0].total);
      const totalPages = Math.ceil(totalAnnouncements / limit);
      
      res.status(200).json({
        status: 200,
        message: 'Announcements retrieved successfully',
        data: {
          announcements,
          pagination: {
            currentPage: parseInt(page),
            totalPages,
            totalAnnouncements,
            hasNextPage: page < totalPages,
            hasPreviousPage: page > 1
          }
        }
      });
      
    } catch (error) {
      console.error('❌ Error fetching announcements:', error);
      console.error('Full error details:', {
        message: error.message,
        code: error.code,
        position: error.position,
        detail: error.detail,
        hint: error.hint
      });
      
      // Return empty result on error to prevent crashes
      res.status(200).json({
        status: 200,
        message: 'Announcements retrieved (with errors)',
        data: {
          announcements: [],
          pagination: {
            currentPage: parseInt(req.query.page || 1),
            totalPages: 0,
            totalAnnouncements: 0,
            hasNextPage: false,
            hasPreviousPage: false
          }
        }
      });
    } finally {
      client.release();
    }
  });
  router.post('/announcements', authenticateTokenSimple, async (req, res) => {
    console.log('📢 Creating announcement from user:', req.user?.id);
    
    // Only allow staff to create announcements
    if (req.user.role === 'Tenant') {
      return res.status(403).json({
        status: 403,
        message: 'Only staff members can create announcements'
      });
    }
    
    const client = await pool.connect();
    
    try {
      const {
        title,
        content,
        priority = 'normal',
        recipients = 'all',
        property_id = null
      } = req.body;
      
      // Validation
      if (!title || !content) {
        return res.status(400).json({
          status: 400,
          message: 'Title and content are required'
        });
      }
      
      await client.query('BEGIN');
      
      let targetUsers = [];
      
      // Get target users based on recipients
      if (recipients === 'all') {
        // Get all tenant users
        const allTenantsQuery = `
          SELECT DISTINCT u.id 
          FROM users u 
          JOIN user_roles ur ON u.role_id = ur.id 
          WHERE ur.role_name = 'Tenant' AND u.is_active = true
        `;
        const result = await client.query(allTenantsQuery);
        targetUsers = result.rows.map(row => row.id);
        
      } else if (property_id) {
        // Get users for specific property
        const propertyTenantsQuery = `
          SELECT DISTINCT u.id
          FROM users u
          JOIN user_roles ur ON u.role_id = ur.id
          JOIN tenants t ON u.tenant_id = t.id
          JOIN lease_tenants lt ON t.id = lt.tenant_id
          JOIN leases l ON lt.lease_id = l.id
          JOIN units un ON l.unit_id = un.id
          WHERE ur.role_name = 'Tenant' 
          AND u.is_active = true 
          AND lt.removed_date IS NULL 
          AND l.lease_status = 'active'
          AND un.property_id = $1
        `;
        const result = await client.query(propertyTenantsQuery, [property_id]);
        targetUsers = result.rows.map(row => row.id);
      }
      
      if (targetUsers.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          status: 400,
          message: 'No valid recipients found'
        });
      }
      
      // Create notifications for all target users
      const isUrgent = priority === 'high';
      let successCount = 0;
      
      for (const userId of targetUsers) {
        try {
          await client.query(`
            INSERT INTO user_notifications 
            (user_id, notification_type, title, message, is_urgent, created_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
          `, [userId, 'announcement', title, content, isUrgent]);
          successCount++;
        } catch (notifError) {
          console.log(`Failed to create notification for user ${userId}:`, notifError.message);
        }
      }
      
      // Log activity if possible
      if (req.user.id) {
        try {
          await client.query(`
            INSERT INTO user_activity_log 
            (user_id, activity_type, activity_description, activity_timestamp)
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
          `, [
            req.user.id,
            'announcement_created',
            `Created announcement: ${title}`
          ]);
        } catch (logError) {
          console.log('Could not log activity:', logError.message);
        }
      }
      
      await client.query('COMMIT');
      
      res.status(201).json({
        status: 201,
        message: 'Announcement sent successfully',
        data: {
          title,
          recipientCount: successCount,
          timestamp: new Date().toISOString()
        }
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Error creating announcement:', error);
      res.status(500).json({
        status: 500,
        message: 'Failed to create announcement',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    } finally {
      client.release();
    }
  });
  
  // Get available recipients for messages (FIXED)
  router.get('/recipients', authenticateTokenSimple, async (req, res) => {
    console.log('👥 Getting recipients for user:', req.user?.id);
    
    // Tenants can only message staff, staff can message anyone
    if (req.user.role === 'Tenant') {
      return res.status(200).json({
        status: 200,
        message: 'Recipients retrieved successfully',
        data: {
          recipients: [
            {
              id: 'staff',
              name: 'Property Management',
              type: 'staff',
              email: 'management@example.com',
              property: 'Management Office'
            }
          ]
        }
      });
    }
    
    const client = await pool.connect();
    
    try {
      const { property_id = null, search = '' } = req.query;
      
      let whereConditions = ['l.lease_status = $1', 'lt.removed_date IS NULL'];
      let queryParams = ['active'];
      let paramCount = 1;
      
      // Filter by property if specified
      if (property_id && property_id !== 'null') {
        paramCount++;
        whereConditions.push(`u.property_id = $${paramCount}`);
        queryParams.push(property_id);
      }
      
      // Search functionality
      if (search && search.trim() !== '') {
        paramCount++;
        whereConditions.push(`(
          t.first_name ILIKE $${paramCount} OR 
          t.last_name ILIKE $${paramCount} OR 
          t.email ILIKE $${paramCount} OR
          p.property_name ILIKE $${paramCount}
        )`);
        queryParams.push(`%${search.trim()}%`);
      }
      
      // Fixed query - removed DISTINCT and added all ORDER BY columns to SELECT
      const recipientsQuery = `
        SELECT 
          t.id,
          t.first_name,
          t.last_name,
          t.first_name || ' ' || t.last_name as name,
          t.email,
          t.phone,
          p.property_name,
          u.unit_number,
          'tenant' as type
        FROM tenants t
        JOIN lease_tenants lt ON t.id = lt.tenant_id
        JOIN leases l ON lt.lease_id = l.id
        JOIN units u ON l.unit_id = u.id
        JOIN properties p ON u.property_id = p.id
        WHERE ${whereConditions.join(' AND ')}
        GROUP BY t.id, t.first_name, t.last_name, t.email, t.phone, p.property_name, u.unit_number
        ORDER BY t.last_name, t.first_name
        LIMIT 50
      `;
      
      const result = await client.query(recipientsQuery, queryParams);
      
      const recipients = result.rows.map(row => ({
        id: row.id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        property: `${row.property_name} - Unit ${row.unit_number}`,
        type: row.type
      }));
      
      res.status(200).json({
        status: 200,
        message: 'Recipients retrieved successfully',
        data: {
          recipients
        }
      });
      
    } catch (error) {
      console.error('❌ Error fetching recipients:', error);
      res.status(500).json({
        status: 500,
        message: 'Failed to fetch recipients',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    } finally {
      client.release();
    }
  });
  
  // Mark notification as read
  router.patch('/notifications/:id/read', authenticateTokenSimple, async (req, res) => {
    console.log('📖 Marking notification as read:', req.params.id);
    
    const client = await pool.connect();
    
    try {
      const { id } = req.params;
      
      // Ensure user can only mark their own notifications as read
      let whereClause = 'id = $1';
      let queryParams = [id];
      
      if (req.user.role === 'Tenant') {
        whereClause += ' AND user_id = $2';
        queryParams.push(req.user.id);
      }
      
      const updateQuery = `
        UPDATE user_notifications 
        SET is_read = true
        WHERE ${whereClause}
        RETURNING id
      `;
      
      const result = await client.query(updateQuery, queryParams);
      
      if (result.rows.length === 0) {
        return res.status(404).json({
          status: 404,
          message: 'Notification not found'
        });
      }
      
      res.status(200).json({
        status: 200,
        message: 'Notification marked as read',
        data: {
          id: result.rows[0].id
        }
      });
      
    } catch (error) {
      console.error('❌ Error marking notification as read:', error);
      res.status(500).json({
        status: 500,
        message: 'Failed to mark notification as read',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    } finally {
      client.release();
    }
  });
  
  // Get properties for announcement targeting (staff only)
  router.get('/properties', authenticateTokenSimple, async (req, res) => {
    console.log('🏢 Getting properties for announcements');
    
    if (req.user.role === 'Tenant') {
      return res.status(403).json({
        status: 403,
        message: 'Access denied'
      });
    }
    
    const client = await pool.connect();
    
    try {
      const propertiesQuery = `
        SELECT 
          p.id,
          p.property_name,
          p.address,
          COUNT(DISTINCT u.id) as total_units,
          COUNT(DISTINCT CASE WHEN l.lease_status = 'active' THEN lt.tenant_id END) as active_tenants
        FROM properties p
        LEFT JOIN units u ON p.id = u.property_id
        LEFT JOIN leases l ON u.id = l.unit_id
        LEFT JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.removed_date IS NULL
        GROUP BY p.id, p.property_name, p.address
        ORDER BY p.property_name
      `;
      
      const result = await client.query(propertiesQuery);
      
      const properties = result.rows.map(row => ({
        id: row.id,
        name: row.property_name,
        address: row.address,
        totalUnits: parseInt(row.total_units) || 0,
        activeTenants: parseInt(row.active_tenants) || 0
      }));
      
      res.status(200).json({
        status: 200,
        message: 'Properties retrieved successfully',
        data: {
          properties
        }
      });
      
    } catch (error) {
      console.error('❌ Error fetching properties:', error);
      res.status(500).json({
        status: 500,
        message: 'Failed to fetch properties',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    } finally {
      client.release();
    }
  });

export default router;