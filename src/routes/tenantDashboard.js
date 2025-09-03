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

    const tenantDocumentsQuery = `
  SELECT 
    id,
    document_type,
    document_name,
    file_size,
    upload_date
  FROM tenant_documents
  WHERE tenant_id = $1
  ORDER BY upload_date DESC
  LIMIT 10
`;

    // Get payment submissions (pending verifications)
    const paymentSubmissionsQuery = `
      SELECT 
        ps.id,
        ps.amount,
        ps.payment_method,
        ps.transaction_reference,
        ps.transaction_date,
        ps.submission_date,
        ps.verification_status,
        ps.verified_date,
        ps.admin_notes,
        ps.notes as tenant_notes
      FROM payment_submissions ps
      WHERE ps.tenant_id = $1
      ORDER BY ps.submission_date DESC
      LIMIT 5
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

    console.log('💳 Executing payment submissions query...');
    const paymentSubmissions = await client.query(paymentSubmissionsQuery, [tenantId]);

    const tenantDocumentsResult = await client.query(tenantDocumentsQuery, [tenantId]);

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
      tenantDocuments: tenantDocumentsResult.rows,
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

// Submit payment verification route (replaces the direct payment processing)
router.post('/tenant/payment/submit', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { 
      amount, 
      paymentMethod, 
      reference, 
      transactionDate, 
      notes 
    } = req.body;
    
    const tenantId = req.user.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        status: 403,
        message: 'Access denied. User is not associated with a tenant account.'
      });
    }

    // Validate required fields
    if (!amount || !paymentMethod || !reference || !transactionDate) {
      return res.status(400).json({
        status: 400,
        message: 'Missing required payment details'
      });
    }

    // Find the tenant's current lease and unit
    const leaseQuery = `
      SELECT l.id as lease_id, l.unit_id, l.monthly_rent
      FROM leases l
      JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.removed_date IS NULL
      WHERE lt.tenant_id = $1 AND l.lease_status = 'active'
      LIMIT 1
    `;

    const leaseResult = await client.query(leaseQuery, [tenantId]);
    
    if (leaseResult.rows.length === 0) {
      return res.status(400).json({
        status: 400,
        message: 'No active lease found for tenant'
      });
    }

    const { lease_id } = leaseResult.rows[0];

    // Create a payment submission record (pending verification)
    const insertQuery = `
      INSERT INTO payment_submissions 
      (
        tenant_id, 
        lease_id, 
        amount, 
        payment_method, 
        transaction_reference, 
        transaction_date, 
        submission_date,
        verification_status,
        notes,
        submitted_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, 'pending', $7, $8)
      RETURNING id, submission_date
    `;

    const result = await client.query(insertQuery, [
      tenantId,
      lease_id,
      amount,
      paymentMethod,
      reference,
      transactionDate,
      notes,
      req.user.id
    ]);

    // Log the activity
    const logQuery = `
      INSERT INTO user_activity_log (user_id, activity_type, activity_description)
      VALUES ($1, 'payment_submitted', $2)
    `;
    
    await client.query(logQuery, [
      req.user.id,
      `Payment submission of ${amount} via ${paymentMethod} (Ref: ${reference})`
    ]);

    // Create notification for tenant
    const notificationQuery = `
      INSERT INTO user_notifications 
      (user_id, notification_type, title, message, related_resource_type, related_resource_id)
      VALUES ($1, 'payment_submitted', 'Payment Submitted', $2, 'payment_submission', $3)
    `;
    
    await client.query(notificationQuery, [
      req.user.id,
      `Your payment of ${amount} has been submitted for verification. You will be notified once it's confirmed.`,
      result.rows[0].id
    ]);

    res.status(201).json({
      status: 201,
      message: 'Payment submitted successfully for verification',
      data: {
        submissionId: result.rows[0].id,
        submissionDate: result.rows[0].submission_date,
        verificationStatus: 'pending',
        estimatedVerificationTime: '24 hours'
      }
    });

  } catch (error) {
    console.error('❌ Payment submission error:', error);
    res.status(500).json({
      status: 500,
      message: 'Failed to submit payment for verification',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});

// Get payment methods and details route
router.get('/tenant/payment-methods', authenticateTokenSimple, async (req, res) => {
  try {
    const tenantId = req.user.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        status: 403,
        message: 'Access denied. User is not associated with a tenant account.'
      });
    }

    // Get tenant's lease number for payment reference
    const client = await pool.connect();
    
    try {
      const leaseQuery = `
        SELECT l.lease_number
        FROM leases l
        JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.removed_date IS NULL
        WHERE lt.tenant_id = $1 AND l.lease_status = 'active'
        LIMIT 1
      `;

      const leaseResult = await client.query(leaseQuery, [tenantId]);
      const leaseNumber = leaseResult.rows[0]?.lease_number || 'LEASE001';

      // Return available payment methods with details
      const paymentMethods = {
        bank_transfer: {
          name: "Bank Transfer",
          details: {
            bankName: "ABC Bank Ltd",
            accountName: "Urban Properties Management",
            accountNumber: "1234567890",
            branchCode: "001",
            swiftCode: "ABCBKENX",
            reference: leaseNumber
          },
          instructions: [
            "Transfer the exact amount to the account above",
            "Use your lease number as the payment reference",
            "Keep your transaction receipt",
            "Submit payment details after transfer"
          ]
        },
        mpesa: {
          name: "M-Pesa",
          details: {
            paybillNumber: "400200",
            businessName: "Urban Properties",
            accountNumber: leaseNumber
          },
          instructions: [
            "Go to M-Pesa menu on your phone",
            "Select 'Lipa na M-Pesa' then 'Pay Bill'",
            "Enter Business Number: 400200",
            `Enter Account Number: ${leaseNumber}`,
            "Enter the amount and complete payment",
            "You'll receive an SMS confirmation",
            "Submit the M-Pesa code below"
          ]
        },
        airtel_money: {
          name: "Airtel Money",
          details: {
            merchantCode: "500300",
            businessName: "Urban Properties",
            accountNumber: leaseNumber
          },
          instructions: [
            "Dial *334# on your Airtel line",
            "Select 'Pay Bills'",
            "Enter Merchant Code: 500300",
            `Enter Reference: ${leaseNumber}`,
            "Enter amount and confirm payment",
            "Save the transaction ID from SMS",
            "Submit transaction details"
          ]
        }
      };

      res.status(200).json({
        status: 200,
        message: 'Payment methods retrieved successfully',
        data: {
          paymentMethods,
          leaseNumber,
          verificationNote: "All payments require admin verification within 24 hours"
        }
      });

    } finally {
      client.release();
    }

  } catch (error) {
    console.error('❌ Payment methods fetch error:', error);
    res.status(500).json({
      status: 500,
      message: 'Failed to fetch payment methods',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get payment submissions history
router.get('/tenant/payment-submissions', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const tenantId = req.user.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        status: 403,
        message: 'Access denied. User is not associated with a tenant account.'
      });
    }

    const submissionsQuery = `
      SELECT 
        ps.id,
        ps.amount,
        ps.payment_method,
        ps.transaction_reference,
        ps.transaction_date,
        ps.submission_date,
        ps.verification_status,
        ps.verified_date,
        ps.verified_by,
        ps.admin_notes,
        ps.notes as tenant_notes,
        l.lease_number
      FROM payment_submissions ps
      JOIN leases l ON ps.lease_id = l.id
      WHERE ps.tenant_id = $1
      ORDER BY ps.submission_date DESC
      LIMIT 20
    `;

    const result = await client.query(submissionsQuery, [tenantId]);

    res.status(200).json({
      status: 200,
      message: 'Payment submissions retrieved successfully',
      data: result.rows.map(submission => ({
        id: submission.id,
        amount: parseFloat(submission.amount),
        paymentMethod: submission.payment_method,
        transactionReference: submission.transaction_reference,
        transactionDate: submission.transaction_date,
        submissionDate: submission.submission_date,
        verificationStatus: submission.verification_status,
        verifiedDate: submission.verified_date,
        verifiedBy: submission.verified_by,
        adminNotes: submission.admin_notes,
        tenantNotes: submission.tenant_notes,
        leaseNumber: submission.lease_number,
        statusColor: submission.verification_status === 'verified' ? 'green' :
                    submission.verification_status === 'rejected' ? 'red' : 'yellow'
      }))
    });

  } catch (error) {
    console.error('❌ Payment submissions fetch error:', error);
    res.status(500).json({
      status: 500,
      message: 'Failed to fetch payment submissions',
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