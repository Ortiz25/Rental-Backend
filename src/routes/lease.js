import express from 'express';
import pool from '../config/database.js';
import { authenticateToken, authorizeRole, authenticateTokenSimple } from '../middleware/auth.js';

const router = express.Router();

// Get all leases with property and tenant information

router.get('/', authenticateTokenSimple, async (req, res) => {
  try {
    const { status, search, page = 1, limit = 10 } = req.query;
    
    let query = `
      SELECT 
        l.id,
        l.lease_number,
        l.lease_type,
        l.lease_status,
        l.start_date,
        l.end_date,
        l.monthly_rent,
        l.security_deposit,
        l.pet_deposit,
        l.late_fee,
        l.grace_period_days,
        l.rent_due_day,
        l.lease_terms,
        l.special_conditions,
        l.signed_date,
        l.move_in_date,
        l.move_out_date,
        l.created_at,
        l.updated_at,
        
        -- Property information
        p.property_name,
        p.address as property_address,
        p.property_type,
        u.unit_number,
        u.bedrooms,
        u.bathrooms,
        u.size_sq_ft,
        
        -- Primary tenant information
        STRING_AGG(
          CASE WHEN lt.is_primary_tenant = true THEN t.first_name || ' ' || t.last_name END, 
          ', '
        ) as primary_tenant_name,
        STRING_AGG(
          CASE WHEN lt.is_primary_tenant = true THEN t.email END, 
          ', '
        ) as primary_tenant_email,
        STRING_AGG(
          CASE WHEN lt.is_primary_tenant = true THEN t.phone END, 
          ', '
        ) as primary_tenant_phone,
        
        -- All tenants
        STRING_AGG(t.first_name || ' ' || t.last_name, ', ' ORDER BY lt.is_primary_tenant DESC) as all_tenant_names,
        STRING_AGG(t.email, ', ' ORDER BY lt.is_primary_tenant DESC) as all_tenant_emails
        
      FROM leases l
      JOIN units u ON l.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      LEFT JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.removed_date IS NULL
      LEFT JOIN tenants t ON lt.tenant_id = t.id
    `;
    
    let whereConditions = [];
    let queryParams = [];
    let paramIndex = 1;
    
    // Add status filter
    if (status) {
      whereConditions.push(`l.lease_status = $${paramIndex}`);
      queryParams.push(status);
      paramIndex++;
    }
    
    // IMPROVED: Add search filter with better tenant matching
    if (search) {
      whereConditions.push(`(
        p.property_name ILIKE $${paramIndex} OR 
        u.unit_number ILIKE $${paramIndex} OR 
        l.lease_number ILIKE $${paramIndex} OR
        t.first_name ILIKE $${paramIndex} OR 
        t.last_name ILIKE $${paramIndex} OR
        t.email ILIKE $${paramIndex} OR
        (t.first_name || ' ' || t.last_name) ILIKE $${paramIndex}
      )`);
      queryParams.push(`%${search}%`);
      paramIndex++;
    }
    
    // Build WHERE clause
    const whereClause = whereConditions.length > 0 ? ' WHERE ' + whereConditions.join(' AND ') : '';
    query += whereClause;
    
    query += `
      GROUP BY l.id, p.property_name, p.address, p.property_type, 
               u.unit_number, u.bedrooms, u.bathrooms, u.size_sq_ft
      ORDER BY l.created_at DESC
    `;
    
    // Add pagination
    const offset = (page - 1) * limit;
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    queryParams.push(parseInt(limit), parseInt(offset));
    
    // Execute main query
    const result = await pool.query(query, queryParams);
    
    res.json({
      success: true,
      data: result.rows,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(result.rows.length / limit),
        totalCount: result.rows.length,
        limit: parseInt(limit)
      }
    });
    
  } catch (error) {
    console.error('Error fetching leases:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching leases',
      error: error.message
    });
  }
});

// Get active leases for utility billing (no pagination)
router.get('/active-for-billing', authenticateTokenSimple, async (req, res) => {
  try {
    const query = `
      SELECT 
        l.id,
        l.lease_number,
        l.monthly_rent,
        l.start_date,
        l.end_date,
        l.rent_due_day,
        p.property_name,
        u.unit_number,
        STRING_AGG(
          CASE WHEN lt.is_primary_tenant = true 
          THEN t.first_name || ' ' || t.last_name END, 
          ', '
        ) as primary_tenant_name,
        STRING_AGG(
          CASE WHEN lt.is_primary_tenant = true THEN t.email END, 
          ', '
        ) as primary_tenant_email
      FROM leases l
      JOIN units u ON l.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      LEFT JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.removed_date IS NULL
      LEFT JOIN tenants t ON lt.tenant_id = t.id
      WHERE l.lease_status = 'active'
      GROUP BY l.id, p.property_name, u.unit_number
      ORDER BY p.property_name, u.unit_number
    `;
    
    const result = await pool.query(query);
    
    res.json({
      success: true,
      data: result.rows
    });
    
  } catch (error) {
    console.error('Error fetching active leases for billing:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching active leases',
      error: error.message
    });
  }
});

// Get single lease by ID with detailed information
router.get('/:id', authenticateTokenSimple, async (req, res) => {
  try {
    const { id } = req.params;
    
    const query = `
      SELECT 
        l.*,
        p.property_name,
        p.address as property_address,
        p.property_type,
        u.unit_number,
        u.bedrooms,
        u.bathrooms,
        u.size_sq_ft,
        
        -- Get all lease tenants
        COALESCE(
          JSON_AGG(
            CASE WHEN t.id IS NOT NULL THEN
              JSON_BUILD_OBJECT(
                'id', t.id,
                'first_name', t.first_name,
                'last_name', t.last_name,
                'email', t.email,
                'phone', t.phone,
                'is_primary_tenant', lt.is_primary_tenant,
                'tenant_type', lt.tenant_type,
                'added_date', lt.added_date
              )
            END
          ) FILTER (WHERE t.id IS NOT NULL), 
          '[]'
        ) as tenants,
        
        -- Get utilities
        COALESCE(
          JSON_AGG(
            CASE WHEN ut.id IS NOT NULL THEN
              JSON_BUILD_OBJECT(
                'id', ut.id,
                'name', ut.name,
                'included', COALESCE(uu.included, pu.included)
              )
            END
          ) FILTER (WHERE ut.id IS NOT NULL),
          '[]'
        ) as utilities,
        
        -- Get amenities
        COALESCE(
          JSON_AGG(
            CASE WHEN am.id IS NOT NULL THEN
              JSON_BUILD_OBJECT(
                'id', am.id,
                'name', am.name
              )
            END
          ) FILTER (WHERE am.id IS NOT NULL),
          '[]'
        ) as amenities
        
      FROM leases l
      JOIN units u ON l.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      LEFT JOIN lease_tenants lt ON l.id = lt.lease_id AND lt.removed_date IS NULL
      LEFT JOIN tenants t ON lt.tenant_id = t.id
      LEFT JOIN unit_utilities uu ON u.id = uu.unit_id
      LEFT JOIN property_utilities pu ON p.id = pu.property_id AND uu.utility_id IS NULL
      LEFT JOIN utilities ut ON COALESCE(uu.utility_id, pu.utility_id) = ut.id
      LEFT JOIN property_amenities pa ON p.id = pa.property_id
      LEFT JOIN amenities am ON pa.amenity_id = am.id
      WHERE l.id = $1
      GROUP BY l.id, p.property_name, p.address, p.property_type, 
               u.unit_number, u.bedrooms, u.bathrooms, u.size_sq_ft
    `;
    
    const result = await pool.query(query, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Lease not found'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
    
  } catch (error) {
    console.error('Error fetching lease:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching lease',
      error: error.message
    });
  }
});

// Create new lease
router.post('/', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const {
      unit_id,
      tenant_ids, // Array of tenant IDs
      lease_type = 'Fixed Term',
      lease_status = 'draft', // Accept from frontend, default to draft
      start_date,
      end_date,
      monthly_rent,
      security_deposit,
      pet_deposit = 0,
      late_fee = 0,
      grace_period_days = 5,
      rent_due_day = 1,
      lease_terms,
      special_conditions,
      signed_date,
      move_in_date
    } = req.body;
    
    // Validate required fields
    if (!unit_id || !tenant_ids || tenant_ids.length === 0 || !start_date || !monthly_rent || !security_deposit) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: unit_id, tenant_ids, start_date, monthly_rent, security_deposit'
      });
    }

    // Additional validation for active leases
    if (lease_status === 'active') {
      if (lease_type === 'Fixed Term' && !end_date) {
        return res.status(400).json({
          success: false,
          message: 'End date is required for active Fixed Term leases'
        });
      }
    }

    // Validate lease status
    const validStatuses = ['draft', 'active', 'pending'];
    if (!validStatuses.includes(lease_status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid lease status. Must be one of: draft, active, pending'
      });
    }
    
    // Check if unit exists and is available
    const unitCheck = await client.query(
      'SELECT id, occupancy_status FROM units WHERE id = $1',
      [unit_id]
    );
    
    if (unitCheck.rows.length === 0) {
      throw new Error('Unit not found');
    }
    
    // If creating an active lease, ensure unit is available
    if (lease_status === 'active' && unitCheck.rows[0].occupancy_status === 'occupied') {
      throw new Error('Cannot create active lease: Unit is already occupied');
    }
    
    // Create the lease (lease_number will be auto-generated by trigger)
    const leaseResult = await client.query(`
      INSERT INTO leases (
        unit_id, lease_type, lease_status, start_date, end_date,
        monthly_rent, security_deposit, pet_deposit, late_fee,
        grace_period_days, rent_due_day, lease_terms, special_conditions,
        signed_date, move_in_date
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *
    `, [
      unit_id, lease_type, lease_status, start_date, end_date, // Use lease_status from request
      monthly_rent, security_deposit, pet_deposit, late_fee,
      grace_period_days, rent_due_day, lease_terms, special_conditions,
      signed_date, move_in_date
    ]);
    
    const lease = leaseResult.rows[0];
    
    // Add tenants to the lease
    for (let i = 0; i < tenant_ids.length; i++) {
      const tenant_id = tenant_ids[i];
      const is_primary = i === 0; // First tenant is primary
      
      await client.query(`
        INSERT INTO lease_tenants (lease_id, tenant_id, is_primary_tenant, tenant_type)
        VALUES ($1, $2, $3, $4)
      `, [lease.id, tenant_id, is_primary, 'Tenant']);
    }

    // If lease is active, create security deposit record
    if (lease_status === 'active' && security_deposit > 0) {
      await client.query(`
        INSERT INTO security_deposits (
          lease_id, deposit_type, amount_collected, collection_date, status
        ) VALUES ($1, $2, $3, $4, $5)
      `, [lease.id, 'Security', security_deposit, signed_date || start_date, 'held']);
    }
    
    await client.query('COMMIT');
    
    // Fetch the complete lease data to return
    const completeLeaseResult = await pool.query(`
      SELECT 
        l.*,
        p.property_name,
        u.unit_number,
        STRING_AGG(t.first_name || ' ' || t.last_name, ', ' ORDER BY lt.is_primary_tenant DESC) as tenant_names
      FROM leases l
      JOIN units u ON l.unit_id = u.id
      JOIN properties p ON u.property_id = p.id
      JOIN lease_tenants lt ON l.id = lt.lease_id
      JOIN tenants t ON lt.tenant_id = t.id
      WHERE l.id = $1
      GROUP BY l.id, p.property_name, u.unit_number
    `, [lease.id]);
    
    res.status(201).json({
      success: true,
      data: completeLeaseResult.rows[0],
      message: `Lease created successfully as ${lease_status}`
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating lease:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating lease',
      error: error.message
    });
  } finally {
    client.release();
  }
});

// Update lease
router.put('/:id', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const updates = req.body;
    
    // Build dynamic update query
    const updateFields = [];
    const values = [];
    let paramIndex = 1;
    
    const allowedFields = [
      'lease_type', 'lease_status', 'start_date', 'end_date',
      'monthly_rent', 'security_deposit', 'pet_deposit', 'late_fee',
      'grace_period_days', 'rent_due_day', 'lease_terms', 'special_conditions',
      'signed_date', 'move_in_date', 'move_out_date'
    ];
    
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        updateFields.push(`${field} = $${paramIndex}`);
        values.push(updates[field]);
        paramIndex++;
      }
    }
    
    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update'
      });
    }
    
    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    
    const query = `
      UPDATE leases 
      SET ${updateFields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;
    
    const result = await client.query(query, values);
    
    if (result.rows.length === 0) {
      throw new Error('Lease not found');
    }
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      data: result.rows[0],
      message: 'Lease updated successfully'
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating lease:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating lease',
      error: error.message
    });
  } finally {
    client.release();
  }
});

// Delete lease
router.delete('/:id', authenticateTokenSimple, async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(
      'DELETE FROM leases WHERE id = $1 RETURNING *',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Lease not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Lease deleted successfully'
    });
    
  } catch (error) {
    console.error('Error deleting lease:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting lease',
      error: error.message
    });
  }
});

// Get lease statistics
router.get('/stats/summary', authenticateTokenSimple, async (req, res) => {
  try {
    const query = `
      SELECT 
        COUNT(*) as total_leases,
        COUNT(CASE WHEN lease_status = 'active' THEN 1 END) as active_leases,
        COUNT(CASE WHEN lease_status = 'pending' THEN 1 END) as pending_leases,
        COUNT(CASE WHEN lease_status = 'expired' THEN 1 END) as expired_leases,
        COUNT(CASE WHEN end_date <= CURRENT_DATE + INTERVAL '30 days' AND lease_status = 'active' THEN 1 END) as expiring_soon,
        SUM(CASE WHEN lease_status = 'active' THEN monthly_rent ELSE 0 END) as total_monthly_revenue,
        AVG(CASE WHEN lease_status = 'active' THEN monthly_rent END) as average_rent
      FROM leases
    `;
    
    const result = await pool.query(query);
    
    res.json({
      success: true,
      data: result.rows[0]
    });
    
  } catch (error) {
    console.error('Error fetching lease statistics:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching lease statistics',
      error: error.message
    });
  }
});

// Renew lease
router.post('/:id/renew', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const { new_end_date, rent_increase, renewal_terms } = req.body;
    
    // Get current lease
    const currentLease = await client.query('SELECT * FROM leases WHERE id = $1', [id]);
    if (currentLease.rows.length === 0) {
      throw new Error('Lease not found');
    }
    
    const lease = currentLease.rows[0];
    const newMonthlyRent = parseFloat(lease.monthly_rent) + parseFloat(rent_increase || 0);
    
    // Update the existing lease
    const result = await client.query(`
      UPDATE leases 
      SET 
        end_date = $1,
        monthly_rent = $2,
        lease_status = 'active',
        special_conditions = COALESCE(special_conditions || E'\\n\\n', '') || $3,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
    `, [new_end_date, newMonthlyRent, `Renewed on ${new Date().toISOString().split('T')[0]}. ${renewal_terms || ''}`, id]);
    
    // Log the renewal
    await client.query(`
      INSERT INTO lease_renewals (original_lease_id, new_lease_id, renewal_date, rent_increase, new_monthly_rent, renewal_terms)
      VALUES ($1, $1, CURRENT_DATE, $2, $3, $4)
    `, [id, rent_increase || 0, newMonthlyRent, renewal_terms]);
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      data: result.rows[0],
      message: 'Lease renewed successfully'
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error renewing lease:', error);
    res.status(500).json({
      success: false,
      message: 'Error renewing lease',
      error: error.message
    });
  } finally {
    client.release();
  }
});

// Cancel lease
router.post('/:id/cancel', authenticateTokenSimple, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const { termination_date, termination_reason, refund_amount } = req.body;
    
    // Update lease status
    const result = await client.query(`
      UPDATE leases 
      SET 
        lease_status = 'terminated',
        move_out_date = $1,
        special_conditions = COALESCE(special_conditions || E'\\n\\n', '') || $2,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
    `, [termination_date, `Terminated on ${new Date().toISOString().split('T')[0]}. Reason: ${termination_reason}`, id]);
    
    if (result.rows.length === 0) {
      throw new Error('Lease not found');
    }
    
    // Handle security deposit refund if specified
    if (refund_amount && parseFloat(refund_amount) > 0) {
      await client.query(`
        UPDATE security_deposits 
        SET 
          amount_returned = $1,
          return_date = $2,
          status = CASE 
            WHEN amount_collected <= $1 THEN 'fully_returned'
            ELSE 'partially_returned'
          END,
          updated_at = CURRENT_TIMESTAMP
        WHERE lease_id = $3
      `, [refund_amount, termination_date, id]);
    }
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      data: result.rows[0],
      message: 'Lease cancelled successfully'
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error cancelling lease:', error);
    res.status(500).json({
      success: false,
      message: 'Error cancelling lease',
      error: error.message
    });
  } finally {
    client.release();
  }
});

export default router;