import express from 'express';
import pool from '../config/database.js';
import { authenticateToken, authenticateTokenSimple } from '../middleware/auth.js';

const router = express.Router();

// Tenant Dashboard Data Route
router.get('/tenant/dashboard', authenticateTokenSimple, async (req, res) => {
  console.log('🏠 Tenant dashboard route accessed by user:', req.user?.id);
  
  const client = await pool.connect();
  
  try {
    // Verify user is a tenant and get tenant_id
    if (!req.user.tenant_id) {
      return res.status(403).json({
        status: 403,
        message: 'Access denied. User is not associated with a tenant account.',
        data: null
      });
    }

    const tenantId = req.user.tenant_id;
    console.log('🔍 Fetching data for tenant ID:', tenantId);

    // Get tenant basic information with current lease
    const tenantInfoQuery = `
      SELECT 
        t.id,
        t.first_name,
        t.last_name,
        t.email,
        t.phone,
        t.emergency_contact_name,
        t.emergency_contact_phone,
        p.property_name,
        p.address as property_address,
        u.unit_number,
        l.id as lease_id,
        l.lease_number,
        l.start_date,
        l.end_date,
        l.monthly_rent,
        l.security_deposit,
        l.lease_status,
        l.rent_due_day,
        l.grace_period_days,
        l.late_fee
      FROM tenants t
      LEFT JOIN lease_tenants lt ON t.id = lt.tenant_id AND lt.removed_date IS NULL
      LEFT JOIN leases l ON lt.lease_id = l.id AND l.lease_status = 'active'
      LEFT JOIN units u ON l.unit_id = u.id
      LEFT JOIN properties p ON u.property_id = p.id
      WHERE t.id = $1
      LIMIT 1
    `;

    // Get rent payment history (last 12 months)
    const rentHistoryQuery = `
      SELECT 
        rp.id,
        rp.due_date,
        rp.payment_date,
        rp.amount_due,
        rp.amount_paid,
        rp.late_fee,
        rp.payment_status,
        rp.payment_method,
        rp.payment_reference,
        'Rent' as type
      FROM rent_payments rp
      JOIN leases l ON rp.lease_id = l.id
      JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.removed_date IS NULL
      WHERE lt.tenant_id = $1
      AND rp.due_date >= CURRENT_DATE - INTERVAL '12 months'
      ORDER BY rp.due_date DESC
      LIMIT 20
    `;

    // Get current balance and next due date
    const balanceQuery = `
      SELECT 
        COALESCE(SUM(CASE WHEN rp.payment_status IN ('overdue', 'pending') THEN rp.amount_due - rp.amount_paid END), 0) as current_balance,
        MIN(CASE WHEN rp.payment_status IN ('overdue', 'pending') THEN rp.due_date END) as next_due_date,
        COUNT(CASE WHEN rp.payment_status = 'overdue' THEN 1 END) as overdue_count
      FROM rent_payments rp
      JOIN leases l ON rp.lease_id = l.id
      JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.removed_date IS NULL
      WHERE lt.tenant_id = $1
    `;

    // Get maintenance requests
    const maintenanceQuery = `
      SELECT 
        mr.id,
        mr.request_title as title,
        mr.description,
        mr.priority,
        mr.status,
        mr.requested_date as submitted,
        mr.scheduled_date as scheduled,
        mr.completed_date,
        mr.category,
        mr.tenant_notes,
        mr.management_notes
      FROM maintenance_requests mr
      WHERE mr.tenant_id = $1
      ORDER BY mr.requested_date DESC
      LIMIT 10
    `;

    // Get notifications
    const notificationsQuery = `
      SELECT 
        un.id,
        un.title,
        un.message as content,
        un.notification_type as type,
        un.created_at as date,
        un.is_read,
        un.is_urgent
      FROM user_notifications un
      JOIN users u ON un.user_id = u.id
      WHERE u.tenant_id = $1
      ORDER BY un.created_at DESC
      LIMIT 10
    `;

    // Get tenant documents
    const documentsQuery = `
      SELECT 
        d.id,
        d.document_name as name,
        d.file_type as type,
        d.uploaded_at as date,
        d.description,
        d.is_important,
        dc.category_name as category
      FROM documents d
      LEFT JOIN document_categories dc ON d.category_id = dc.id
      WHERE d.tenant_id = $1 
      AND d.document_status = 'active'
      ORDER BY d.uploaded_at DESC
      LIMIT 10
    `;

    // Execute all queries
    console.log('📊 Executing tenant info query...');
    const tenantInfo = await client.query(tenantInfoQuery, [tenantId]);
    
    console.log('💰 Executing rent history query...');
    const rentHistory = await client.query(rentHistoryQuery, [tenantId]);
    
    console.log('🧮 Executing balance query...');
    const balanceInfo = await client.query(balanceQuery, [tenantId]);
    
    console.log('🔧 Executing maintenance query...');
    const maintenanceRequests = await client.query(maintenanceQuery, [tenantId]);
    
    console.log('🔔 Executing notifications query...');
    const notifications = await client.query(notificationsQuery, [tenantId]);
    
    console.log('📄 Executing documents query...');
    const documents = await client.query(documentsQuery, [tenantId]);

    // Check if tenant exists
    if (tenantInfo.rows.length === 0) {
      return res.status(404).json({
        status: 404,
        message: 'Tenant not found',
        data: null
      });
    }

    const tenant = tenantInfo.rows[0];
    const balance = balanceInfo.rows[0];

    // Calculate next due date if not found in overdue/pending
    let nextDueDate = balance.next_due_date;
    if (!nextDueDate && tenant.lease_id && tenant.rent_due_day) {
      const today = new Date();
      const currentMonth = today.getMonth();
      const currentYear = today.getFullYear();
      
      // If we're past this month's due date, next due is next month
      const thisMonthDue = new Date(currentYear, currentMonth, tenant.rent_due_day);
      nextDueDate = today > thisMonthDue 
        ? new Date(currentYear, currentMonth + 1, tenant.rent_due_day)
        : thisMonthDue;
    }

    // Format the response data
    const tenantData = {
      tenant: {
        id: tenant.id,
        name: `${tenant.first_name} ${tenant.last_name}`,
        email: tenant.email,
        phone: tenant.phone,
        unit: tenant.unit_number || 'N/A',
        propertyName: tenant.property_name || 'N/A',
        propertyAddress: tenant.property_address || 'N/A',
        leaseStart: tenant.start_date,
        leaseEnd: tenant.end_date,
        rentAmount: parseFloat(tenant.monthly_rent) || 0,
        securityDeposit: parseFloat(tenant.security_deposit) || 0,
        balance: parseFloat(balance.current_balance) || 0,
        nextDueDate: nextDueDate,
        leaseStatus: tenant.lease_status,
        leaseNumber: tenant.lease_number,
        emergencyContact: {
          name: tenant.emergency_contact_name,
          phone: tenant.emergency_contact_phone
        }
      },
      rentHistory: rentHistory.rows.map(payment => ({
        id: payment.id,
        date: payment.payment_date || payment.due_date,
        dueDate: payment.due_date,
        paymentDate: payment.payment_date,
        amount: parseFloat(payment.amount_paid) || parseFloat(payment.amount_due),
        amountDue: parseFloat(payment.amount_due),
        amountPaid: parseFloat(payment.amount_paid),
        lateFee: parseFloat(payment.late_fee) || 0,
        status: payment.payment_status === 'paid' ? 'Paid' : 
               payment.payment_status === 'overdue' ? 'Overdue' :
               payment.payment_status === 'pending' ? 'Pending' : 'Partial',
        type: payment.type,
        method: payment.payment_method,
        reference: payment.payment_reference
      })),
      maintenanceRequests: maintenanceRequests.rows.map(request => ({
        id: request.id,
        title: request.title,
        description: request.description,
        status: request.status === 'open' ? 'Open' :
               request.status === 'in_progress' ? 'In Progress' :
               request.status === 'completed' ? 'Completed' : 
               request.status === 'cancelled' ? 'Cancelled' : 'On Hold',
        priority: request.priority.charAt(0).toUpperCase() + request.priority.slice(1),
        submitted: request.submitted,
        scheduled: request.scheduled,
        completed: request.completed_date,
        category: request.category,
        tenantNotes: request.tenant_notes,
        managementNotes: request.management_notes
      })),
      notifications: notifications.rows.map(notification => ({
        id: notification.id,
        title: notification.title,
        content: notification.content,
        type: notification.type,
        date: notification.date,
        isRead: notification.is_read,
        isUrgent: notification.is_urgent
      })),
      documents: documents.rows.map(doc => ({
        id: doc.id,
        name: doc.name,
        type: doc.type.toUpperCase(),
        date: doc.date,
        description: doc.description,
        category: doc.category,
        isImportant: doc.is_important
      })),
      stats: {
        overduePayments: parseInt(balance.overdue_count) || 0,
        activeMaintenanceRequests: maintenanceRequests.rows.filter(r => 
          ['open', 'in_progress'].includes(r.status)
        ).length,
        unreadNotifications: notifications.rows.filter(n => !n.is_read).length,
        totalDocuments: documents.rows.length
      }
    };

    console.log('✅ Tenant dashboard data compiled successfully');

    res.status(200).json({
      status: 200,
      message: 'Tenant dashboard data retrieved successfully',
      data: tenantData
    });

  } catch (error) {
    console.error('❌ Tenant dashboard data fetch error:', error);
    
    res.status(500).json({
      status: 500,
      message: 'Failed to fetch tenant dashboard data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// Make payment route
router.post('/tenant/payment', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { amount, paymentMethod, paymentReference } = req.body;
    const tenantId = req.user.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        status: 403,
        message: 'Access denied. User is not associated with a tenant account.'
      });
    }

    // Find the oldest unpaid rent payment
    const unpaidQuery = `
      SELECT rp.id, rp.amount_due, rp.amount_paid
      FROM rent_payments rp
      JOIN leases l ON rp.lease_id = l.id
      JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.removed_date IS NULL
      WHERE lt.tenant_id = $1 
      AND rp.payment_status IN ('pending', 'overdue')
      ORDER BY rp.due_date ASC
      LIMIT 1
    `;

    const unpaidResult = await client.query(unpaidQuery, [tenantId]);
    
    if (unpaidResult.rows.length === 0) {
      return res.status(400).json({
        status: 400,
        message: 'No pending payments found'
      });
    }

    const payment = unpaidResult.rows[0];
    const remainingAmount = payment.amount_due - payment.amount_paid;
    const paymentAmount = Math.min(amount, remainingAmount);
    const newTotalPaid = payment.amount_paid + paymentAmount;
    const newStatus = newTotalPaid >= payment.amount_due ? 'paid' : 'partial';

    // Update the payment
    const updateQuery = `
      UPDATE rent_payments 
      SET 
        amount_paid = $1,
        payment_status = $2,
        payment_method = $3,
        payment_reference = $4,
        payment_date = CASE WHEN $2 = 'paid' THEN CURRENT_DATE ELSE payment_date END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING *
    `;

    await client.query(updateQuery, [
      newTotalPaid,
      newStatus,
      paymentMethod,
      paymentReference,
      payment.id
    ]);

    // Log the activity
    const logQuery = `
      INSERT INTO user_activity_log (user_id, activity_type, activity_description)
      VALUES ($1, 'payment_made', 'Payment of $${paymentAmount} made via ${paymentMethod}')
    `;
    
    await client.query(logQuery, [req.user.id]);

    res.status(200).json({
      status: 200,
      message: 'Payment processed successfully',
      data: {
        paymentAmount: paymentAmount,
        newStatus: newStatus,
        remainingBalance: payment.amount_due - newTotalPaid
      }
    });

  } catch (error) {
    console.error('❌ Payment processing error:', error);
    res.status(500).json({
      status: 500,
      message: 'Failed to process payment',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// Submit maintenance request route
router.post('/tenant/maintenance', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { title, description, priority, category } = req.body;
    const tenantId = req.user.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        status: 403,
        message: 'Access denied. User is not associated with a tenant account.'
      });
    }

    // Get tenant's current unit
    const unitQuery = `
      SELECT l.unit_id, l.id as lease_id
      FROM leases l
      JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.removed_date IS NULL
      WHERE lt.tenant_id = $1 AND l.lease_status = 'active'
      LIMIT 1
    `;

    const unitResult = await client.query(unitQuery, [tenantId]);
    
    if (unitResult.rows.length === 0) {
      return res.status(400).json({
        status: 400,
        message: 'No active lease found for tenant'
      });
    }

    const { unit_id, lease_id } = unitResult.rows[0];

    // Insert maintenance request
    const insertQuery = `
      INSERT INTO maintenance_requests 
      (unit_id, tenant_id, lease_id, request_title, description, priority, category, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
      RETURNING id, requested_date
    `;

    const result = await client.query(insertQuery, [
      unit_id,
      tenantId,
      lease_id,
      title,
      description,
      priority.toLowerCase(),
      category
    ]);

    // Log the activity
    const logQuery = `
      INSERT INTO user_activity_log (user_id, activity_type, activity_description)
      VALUES ($1, 'maintenance_request', 'Submitted maintenance request: ${title}')
    `;
    
    await client.query(logQuery, [req.user.id]);

    res.status(201).json({
      status: 201,
      message: 'Maintenance request submitted successfully',
      data: {
        requestId: result.rows[0].id,
        submittedDate: result.rows[0].requested_date
      }
    });

  } catch (error) {
    console.error('❌ Maintenance request submission error:', error);
    res.status(500).json({
      status: 500,
      message: 'Failed to submit maintenance request',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// Get tenant documents route
router.get('/tenant/documents', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const tenantId = req.user.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        status: 403,
        message: 'Access denied. User is not associated with a tenant account.'
      });
    }

    const documentsQuery = `
      SELECT 
        d.id,
        d.document_name,
        d.file_type,
        d.file_path,
        d.file_size,
        d.uploaded_at,
        d.description,
        d.is_important,
        d.expires_at,
        dc.category_name,
        'download' as action_url
      FROM documents d
      LEFT JOIN document_categories dc ON d.category_id = dc.id
      WHERE (d.tenant_id = $1 OR d.lease_id IN (
        SELECT l.id FROM leases l
        JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.removed_date IS NULL
        WHERE lt.tenant_id = $1
      ))
      AND d.document_status = 'active'
      ORDER BY d.is_important DESC, d.uploaded_at DESC
    `;

    const result = await client.query(documentsQuery, [tenantId]);

    res.status(200).json({
      status: 200,
      message: 'Documents retrieved successfully',
      data: result.rows
    });

  } catch (error) {
    console.error('❌ Documents fetch error:', error);
    res.status(500).json({
      status: 500,
      message: 'Failed to fetch documents',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

export default router;