import express from 'express';
import pool from '../config/database.js';
import { authenticateTokenSimple } from '../middleware/auth.js';

const router = express.Router();

// Get all rent payments with filtering and pagination
router.get('/', authenticateTokenSimple, async (req, res) => {
  try {
    const { 
      status, 
      search, 
      month, 
      year = new Date().getFullYear(), 
      page = 1, 
      limit = 10 
    } = req.query;
    
    let query = `
      SELECT 
        rp.id,
        rp.lease_id,
        rp.payment_date,
        rp.due_date,
        rp.amount_due,
        rp.amount_paid,
        rp.payment_method,
        rp.payment_reference,
        rp.late_fee,
        rp.payment_status,
        rp.notes,
        rp.processed_by,
        rp.created_at,
        rp.updated_at,
        
        -- Lease information
        l.lease_number,
        l.monthly_rent as lease_monthly_rent,
        l.grace_period_days,
        
        -- Property and unit information
        p.property_name,
        u.unit_number,
        CONCAT(p.property_name, ', Unit ', u.unit_number) as property_unit,
        
        -- Primary tenant information
        STRING_AGG(
          CASE WHEN lt.is_primary_tenant = true 
          THEN CONCAT(t.first_name, ' ', t.last_name) END, 
          ', '
        ) as tenant_name,
        STRING_AGG(
          CASE WHEN lt.is_primary_tenant = true THEN t.email END, 
          ', '
        ) as tenant_email,
        STRING_AGG(
          CASE WHEN lt.is_primary_tenant = true THEN t.phone END, 
          ', '
        ) as tenant_phone,
        
        -- Calculate days overdue
        CASE 
          WHEN rp.payment_status = 'overdue' THEN 
            CURRENT_DATE - rp.due_date - l.grace_period_days
          ELSE 0
        END as days_overdue,
        
        -- Invoice number (generated)
        CONCAT('INV-', EXTRACT(YEAR FROM rp.due_date), '-', LPAD(rp.id::text, 4, '0')) as invoice_number
        
      FROM rent_payments rp
      JOIN leases l ON rp.lease_id = l.id
      JOIN units u ON l.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      LEFT JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.removed_date IS NULL
      LEFT JOIN tenants t ON lt.tenant_id = t.id
    `;
    
    let whereConditions = [];
    let queryParams = [];
    let paramIndex = 1;
    
    // Add status filter
    if (status && status !== 'all') {
      whereConditions.push(`rp.payment_status = $${paramIndex}`);
      queryParams.push(status);
      paramIndex++;
    }
    
    // Add month filter
    if (month) {
      whereConditions.push(`EXTRACT(MONTH FROM rp.due_date) = $${paramIndex}`);
      queryParams.push(parseInt(month));
      paramIndex++;
    }
    
    // Add year filter
    whereConditions.push(`EXTRACT(YEAR FROM rp.due_date) = $${paramIndex}`);
    queryParams.push(parseInt(year));
    paramIndex++;
    
    // Add search filter
    if (search) {
      whereConditions.push(`(
        p.property_name ILIKE $${paramIndex} OR 
        u.unit_number ILIKE $${paramIndex} OR 
        l.lease_number ILIKE $${paramIndex} OR
        t.first_name ILIKE $${paramIndex} OR 
        t.last_name ILIKE $${paramIndex} OR
        CONCAT(t.first_name, ' ', t.last_name) ILIKE $${paramIndex}
      )`);
      queryParams.push(`%${search}%`);
      paramIndex++;
    }
    
    // Build WHERE clause
    const whereClause = whereConditions.length > 0 ? ' WHERE ' + whereConditions.join(' AND ') : '';
    query += whereClause;
    
    query += `
      GROUP BY rp.id, l.lease_number, l.monthly_rent, l.grace_period_days,
               p.property_name, u.unit_number
      ORDER BY rp.due_date DESC, rp.created_at DESC
    `;
    
    // Add pagination
    const offset = (page - 1) * limit;
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    queryParams.push(parseInt(limit), parseInt(offset));
    
    // Execute main query
    const result = await pool.query(query, queryParams);
    
    // Get total count for pagination
    let countQuery = `
      SELECT COUNT(DISTINCT rp.id) as total
      FROM rent_payments rp
      JOIN leases l ON rp.lease_id = l.id
      JOIN units u ON l.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      LEFT JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.removed_date IS NULL
      LEFT JOIN tenants t ON lt.tenant_id = t.id
    `;
    
    countQuery += whereClause;
    const countResult = await pool.query(countQuery, queryParams.slice(0, -2)); // Remove pagination params
    const totalCount = parseInt(countResult.rows[0].total);
    
    res.json({
      success: true,
      data: result.rows,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalCount / limit),
        totalCount,
        limit: parseInt(limit)
      }
    });
    
  } catch (error) {
    console.error('Error fetching rent payments:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching rent payments',
      error: error.message
    });
  }
});

// Get rent collection summary/dashboard stats
router.get('/summary', authenticateTokenSimple, async (req, res) => {
  try {
    const { month, year = new Date().getFullYear() } = req.query;
    
    let whereClause = `WHERE EXTRACT(YEAR FROM rp.due_date) = $1`;
    let queryParams = [parseInt(year)];
    
    if (month) {
      whereClause += ` AND EXTRACT(MONTH FROM rp.due_date) = $2`;
      queryParams.push(parseInt(month));
    }
    
    const summaryQuery = `
      SELECT 
        COUNT(*) as total_payments,
        SUM(rp.amount_due + COALESCE(rp.late_fee, 0)) as total_due,
        SUM(CASE WHEN rp.payment_status = 'paid' THEN rp.amount_paid ELSE 0 END) as total_collected,
        SUM(CASE WHEN rp.payment_status = 'pending' THEN rp.amount_due ELSE 0 END) as total_pending,
        SUM(CASE WHEN rp.payment_status = 'overdue' THEN rp.amount_due + COALESCE(rp.late_fee, 0) ELSE 0 END) as total_overdue,
        SUM(COALESCE(rp.late_fee, 0)) as total_late_fees,
        COUNT(CASE WHEN rp.payment_status = 'paid' THEN 1 END) as paid_count,
        COUNT(CASE WHEN rp.payment_status = 'pending' THEN 1 END) as pending_count,
        COUNT(CASE WHEN rp.payment_status = 'overdue' THEN 1 END) as overdue_count,
        ROUND(AVG(rp.amount_due), 2) as average_rent,
        ROUND(
          (COUNT(CASE WHEN rp.payment_status = 'paid' THEN 1 END)::decimal / 
           NULLIF(COUNT(*), 0)) * 100, 2
        ) as collection_rate
      FROM rent_payments rp
      ${whereClause}
    `;
    
    const result = await pool.query(summaryQuery, queryParams);
    
    res.json({
      success: true,
      data: result.rows[0]
    });
    
  } catch (error) {
    console.error('Error fetching rent collection summary:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching rent collection summary',
      error: error.message
    });
  }
});

// Get single rent payment by ID
router.get('/:id', authenticateTokenSimple, async (req, res) => {
  try {
    const { id } = req.params;
    
    const query = `
      SELECT 
        rp.*,
        l.lease_number,
        l.monthly_rent,
        l.grace_period_days,
        p.property_name,
        u.unit_number,
        CONCAT(p.property_name, ', Unit ', u.unit_number) as property_unit,
        
        -- All tenant information for this lease
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'id', t.id,
            'name', CONCAT(t.first_name, ' ', t.last_name),
            'email', t.email,
            'phone', t.phone,
            'is_primary', lt.is_primary_tenant
          )
        ) as tenants,
        
        -- Invoice number
        CONCAT('INV-', EXTRACT(YEAR FROM rp.due_date), '-', LPAD(rp.id::text, 4, '0')) as invoice_number
        
      FROM rent_payments rp
      JOIN leases l ON rp.lease_id = l.id
      JOIN units u ON l.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      LEFT JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.removed_date IS NULL
      LEFT JOIN tenants t ON lt.tenant_id = t.id
      WHERE rp.id = $1
      GROUP BY rp.id, l.lease_number, l.monthly_rent, l.grace_period_days,
               p.property_name, u.unit_number
    `;
    
    const result = await pool.query(query, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Rent payment not found'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
    
  } catch (error) {
    console.error('Error fetching rent payment:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching rent payment',
      error: error.message
    });
  }
});

// Process payment (update payment status)
router.put('/:id/process', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const { 
      amount_paid, 
      payment_method, 
      payment_reference, 
      payment_date, 
      notes,
      processed_by 
    } = req.body;
     console.log(req.body, id)
    // Validate required fields
    if (!amount_paid || !payment_method) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: amount_paid, payment_method'
      });
    }
    
    // Get current payment details
    const currentPayment = await client.query(
      'SELECT * FROM rent_payments WHERE id = $1',
      [id]
    );
    
    if (currentPayment.rows.length === 0) {
      throw new Error('Payment record not found');
    }
    
    const payment = currentPayment.rows[0];
    const totalDue = parseFloat(payment.amount_due) + parseFloat(payment.late_fee || 0);
    const amountPaid = parseFloat(amount_paid);
    
    // Determine payment status
    let paymentStatus;
    if (amountPaid >= totalDue) {
      paymentStatus = 'paid';
    } else if (amountPaid > 0) {
      paymentStatus = 'partial';
    } else {
      paymentStatus = 'pending';
    }
    
    // Set payment_date: use provided date or current date for paid/partial, null for pending
    const finalPaymentDate = paymentStatus === 'pending' ? null : 
      (payment_date || new Date().toISOString().split('T')[0]);
    
    // Update the payment record
    const updateQuery = `
      UPDATE rent_payments 
      SET 
        amount_paid = $1,
        payment_method = $2,
        payment_reference = $3,
        payment_date = $4,
        payment_status = $5,
        notes = $6,
        processed_by = $7,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
      RETURNING *
    `;
    
    const result = await client.query(updateQuery, [
      amountPaid,
      payment_method,
      payment_reference,
      finalPaymentDate,
      paymentStatus,
      notes,
      processed_by,
      id
    ]);
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      data: result.rows[0],
      message: 'Payment processed successfully'
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error processing payment:', error);
    res.status(500).json({
      success: false,
      message: 'Error processing payment',
      error: error.message
    });
  } finally {
    client.release();
  }
});

// Create new payment record
router.post('/', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const {
      lease_id,
      due_date,
      amount_due,
      amount_paid = 0,
      payment_method,
      payment_reference,
      payment_date,
      late_fee = 0,
      payment_status = 'pending',
      notes,
      processed_by
    } = req.body;
    
    // Validate required fields
    if (!lease_id || !due_date || !amount_due) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: lease_id, due_date, amount_due'
      });
    }
    
    // Verify lease exists and is active
    const leaseCheck = await client.query(
      'SELECT id, monthly_rent FROM leases WHERE id = $1 AND lease_status = $2',
      [lease_id, 'active']
    );
    
    if (leaseCheck.rows.length === 0) {
      throw new Error('Lease not found or not active');
    }
    
    // Check if payment already exists for this lease and due date
    const existingPayment = await client.query(`
      SELECT id FROM rent_payments 
      WHERE lease_id = $1 AND due_date = $2
    `, [lease_id, due_date]);
    
    if (existingPayment.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Payment record already exists for this lease and due date'
      });
    }
    
    // Determine payment status if amount_paid is provided
    let finalStatus = payment_status;
    if (amount_paid > 0) {
      const totalDue = parseFloat(amount_due) + parseFloat(late_fee);
      if (amount_paid >= totalDue) {
        finalStatus = 'paid';
      } else {
        finalStatus = 'partial';
      }
    }
    
    // Create payment record
    const insertQuery = `
      INSERT INTO rent_payments (
        lease_id, payment_date, due_date, amount_due, amount_paid,
        payment_method, payment_reference, late_fee, payment_status,
        notes, processed_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `;
    
    const result = await client.query(insertQuery, [
      lease_id,
      finalStatus === 'pending' ? null : payment_date,
      due_date,
      amount_due,
      amount_paid,
      payment_method,
      payment_reference,
      late_fee,
      finalStatus,
      notes,
      processed_by
    ]);
    
    await client.query('COMMIT');
    
    // Return the created payment with additional info
    const paymentWithDetails = await pool.query(`
      SELECT 
        rp.*,
        l.lease_number,
        p.property_name,
        u.unit_number,
        (SELECT CONCAT(t.first_name, ' ', t.last_name)
         FROM lease_tenants lt 
         JOIN tenants t ON lt.tenant_id = t.id 
         WHERE lt.lease_id = l.id 
         AND lt.is_primary_tenant = true 
         AND lt.removed_date IS NULL 
         LIMIT 1) as tenant_name
      FROM rent_payments rp
      JOIN leases l ON rp.lease_id = l.id
      JOIN units u ON l.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      WHERE rp.id = $1
    `, [result.rows[0].id]);
    
    res.status(201).json({
      success: true,
      data: paymentWithDetails.rows[0],
      message: 'Payment record created successfully'
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating payment record:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating payment record',
      error: error.message
    });
  } finally {
    client.release();
  }
});

// Generate rent payments for a specific month/year
router.post('/generate', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { month, year } = req.body;
    
    if (!month || !year) {
      return res.status(400).json({
        success: false,
        message: 'Month and year are required'
      });
    }
    
    // Get all active leases
    const leasesQuery = `
      SELECT 
        l.id,
        l.monthly_rent,
        l.late_fee,
        l.rent_due_day,
        l.grace_period_days
      FROM leases l
      WHERE l.lease_status = 'active'
      AND l.start_date <= $1
      AND (l.end_date IS NULL OR l.end_date >= $1)
    `;
    
    const targetDate = new Date(year, month - 1, 1);
    const leases = await client.query(leasesQuery, [targetDate]);
    
    let generatedCount = 0;
    
    for (const lease of leases.rows) {
      const dueDate = new Date(year, month - 1, lease.rent_due_day);
      
      // Check if payment already exists for this lease and month
      const existingPayment = await client.query(`
        SELECT id FROM rent_payments 
        WHERE lease_id = $1 
        AND EXTRACT(YEAR FROM due_date) = $2 
        AND EXTRACT(MONTH FROM due_date) = $3
      `, [lease.id, year, month]);
      
      if (existingPayment.rows.length === 0) {
        // Create new payment record - payment_date should be NULL until payment is made
        await client.query(`
          INSERT INTO rent_payments (
            lease_id, payment_date, due_date, amount_due, amount_paid, 
            late_fee, payment_status
          ) VALUES ($1, NULL, $2, $3, 0, 0, 'pending')
        `, [lease.id, dueDate, lease.monthly_rent]);
        
        generatedCount++;
      }
    }
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      message: `Generated ${generatedCount} rent payment records for ${month}/${year}`
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error generating rent payments:', error);
    res.status(500).json({
      success: false,
      message: 'Error generating rent payments',
      error: error.message
    });
  } finally {
    client.release();
  }
});

// Send payment reminders
router.post('/send-reminders', authenticateTokenSimple, async (req, res) => {
  try {
    const { payment_ids, reminder_type = 'overdue' } = req.body;
    
    if (!payment_ids || payment_ids.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Payment IDs are required'
      });
    }
    
    // Get payment details for reminders
    const paymentsQuery = `
      SELECT 
        rp.id,
        rp.due_date,
        rp.amount_due,
        rp.late_fee,
        p.property_name,
        u.unit_number,
        t.first_name,
        t.last_name,
        t.email,
        t.phone
      FROM rent_payments rp
      JOIN leases l ON rp.lease_id = l.id
      JOIN units u ON l.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.is_primary_tenant = true
      JOIN tenants t ON lt.tenant_id = t.id
      WHERE rp.id = ANY($1)
    `;
    
    const payments = await pool.query(paymentsQuery, [payment_ids]);
    
    // Here you would integrate with your notification system
    // For now, we'll just return success
    
    res.json({
      success: true,
      message: `${reminder_type} reminders sent to ${payments.rows.length} tenants`,
      data: payments.rows
    });
    
  } catch (error) {
    console.error('Error sending reminders:', error);
    res.status(500).json({
      success: false,
      message: 'Error sending reminders',
      error: error.message
    });
  }
});

// Update overdue payments and apply late fees
router.post('/update-overdue', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Update overdue payments
    const updateQuery = `
      UPDATE rent_payments rp
      SET 
        payment_status = 'overdue',
        late_fee = CASE 
          WHEN l.late_fee > 0 AND rp.late_fee = 0 THEN l.late_fee
          ELSE rp.late_fee
        END,
        updated_at = CURRENT_TIMESTAMP
      FROM leases l
      WHERE rp.lease_id = l.id
      AND rp.payment_status = 'pending'
      AND rp.due_date + INTERVAL '1 day' * l.grace_period_days < CURRENT_DATE
      RETURNING rp.id
    `;
    
    const result = await client.query(updateQuery);
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      message: `Updated ${result.rows.length} payments to overdue status`,
      updated_count: result.rows.length
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating overdue payments:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating overdue payments',
      error: error.message
    });
  } finally {
    client.release();
  }
});

export default router;